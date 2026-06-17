import { IncomingForm } from 'formidable';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';

export const config = {
    api: {
        bodyParser: false,
    },
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Invalid request method. Please send a POST request.' });
    }

    try {
        // 1. Parse incoming request
        const data = await new Promise((resolve, reject) => {
            const form = new IncomingForm();
            form.parse(req, (err, fields, files) => {
                if (err) return reject(err);
                resolve({ fields, files });
            });
        });

        const uploadedFile = Array.isArray(data.files.file) ? data.files.file[0] : data.files.file;

        if (!uploadedFile) {
            return res.status(400).json({ error: 'Missing image in the payload.' });
        }

        if (!process.env.GEMINI_API_KEY) {
            throw new Error("Missing GEMINI_API_KEY environment variable.");
        }

        const imageBuffer = fs.readFileSync(uploadedFile.filepath);
        const base64Data = imageBuffer.toString('base64');
        const mimeType = uploadedFile.mimetype || 'image/jpeg';

        // 2. Fetch ONLY headers + one sample row from JSONBin (not the full dataset)
        const { JSONBIN_MASTER_KEY, JSONBIN_ACCESS_KEY, JSONBIN_BIN_ID } = process.env;
        let existingHeaders = [];
        let sampleRow = null;

        if (JSONBIN_BIN_ID && (JSONBIN_ACCESS_KEY || JSONBIN_MASTER_KEY)) {
            try {
                const getRes = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
                    headers: { 'X-Access-Key': JSONBIN_ACCESS_KEY || JSONBIN_MASTER_KEY }
                });

                if (getRes.ok) {
                    const parsedRes = await getRes.json();
                    const currentData = parsedRes.record;
                    if (Array.isArray(currentData) && currentData.length > 0) {
                        sampleRow = currentData[0];
                        existingHeaders = Object.keys(sampleRow);
                    }
                }
            } catch (schemaError) {
                console.warn("Could not fetch existing schema, proceeding without it:", schemaError.message);
                // Non-fatal — Gemini will infer headers fresh if this fails
            }
        }

        // 3. Build the extraction prompt, including schema context only if it exists
        let schemaContext = '';
        if (existingHeaders.length > 0) {
            schemaContext = `
EXISTING SCHEMA CONTEXT:
The dataset already uses these exact column headers: ${JSON.stringify(existingHeaders)}
Here is one sample row showing the expected format for each field:
${JSON.stringify(sampleRow)}

MATCHING RULES (follow strictly):
- If from the image you notice the headers take them then
- If a field in the new document clearly and confidently represents the same information as an existing header, reuse that EXACT header name (same spelling, case, and wording).
- Only create a new header if you are confident the field does not match any existing header in meaning.
- Do NOT create near-duplicate headers (e.g. do not create "Date" if "date" already exists, do not create "Officer" if "Officer Name" already exists). When in doubt about whether two headers mean the same thing, prefer reusing the existing one only if you are highly confident; otherwise create a new, clearly distinct header.
- If a row has no value for one of the existing headers, set that field to null. Do not omit the key.
`;
        }

        const defaultPrompt = `
You are extracting structured data from a photographed page. Your output will be merged into an existing dataset, so consistency with the existing schema matters.

${schemaContext}

EXTRACTION RULES:
1. Identify every column/field visible in the document, including handwritten annotations, stamps, marginal notes, and partially legible text — do not skip or summarize any visible data.
2. Map each field to an existing header if the matching rules above apply; otherwise infer a clear, descriptive new header.
3. Preserve all original values exactly as written — do not paraphrase, correct spelling, normalize formatting, or infer values that are not visibly present. If a value is illegible, set it to null then put your suggested value in bracket.
4. Each row in the document becomes one object in the output array.
5. Output strictly a valid JSON array. No conversational text, no markdown wrappers, no backticks, no explanations.
`;

        const userProvidedPrompt = Array.isArray(data.fields.customPrompt)
            ? data.fields.customPrompt[0]
            : data.fields.customPrompt;

        const finalPrompt = userProvidedPrompt || defaultPrompt;

        // 4. Execute the model request
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        const result = await model.generateContent([
            finalPrompt,
            {
                inlineData: {
                    data: base64Data,
                    mimeType: mimeType
                }
            }
        ]);

        const responseText = result.response.text();

        // 5. Extract JSON robustly
        let structuredData;
        try {
            const startArray = responseText.indexOf('[');
            const startObject = responseText.indexOf('{');
            let startIdx = -1;
            let endIdx = -1;

            if (startArray !== -1 && (startObject === -1 || startArray < startObject)) {
                startIdx = startArray;
                endIdx = responseText.lastIndexOf(']');
            } else if (startObject !== -1) {
                startIdx = startObject;
                endIdx = responseText.lastIndexOf('}');
            }

            if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
                throw new Error("Could not find boundaries of JSON in model response");
            }

            const rawJson = responseText.substring(startIdx, endIdx + 1);
            const cleanedJson = rawJson
                .replace(/,\s*([\]}])/g, '$1')
                .replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');

            structuredData = JSON.parse(cleanedJson);
        } catch (parseError) {
            console.error("Advanced JSON parsing failed, fallback to basic sanitization:", parseError);
            const sanitizedOutput = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
            structuredData = JSON.parse(sanitizedOutput);
        }

        if (!Array.isArray(structuredData)) {
            structuredData = [structuredData];
        }

        try {
            fs.unlinkSync(uploadedFile.filepath);
        } catch (cleanupError) {
            console.warn("Could not remove temporary file:", cleanupError);
        }

        // 6. Append to JSONBin
        if (JSONBIN_MASTER_KEY && JSONBIN_BIN_ID) {
            try {
                const getRes = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
                    headers: { 'X-Access-Key': JSONBIN_ACCESS_KEY || JSONBIN_MASTER_KEY }
                });

                let currentData = [];
                if (getRes.ok) {
                    const parsedRes = await getRes.json();
                    currentData = parsedRes.record || [];
                    if (!Array.isArray(currentData)) currentData = [];
                }

                const mergedData = [...currentData, ...structuredData];

                const putRes = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Master-Key': JSONBIN_MASTER_KEY
                    },
                    body: JSON.stringify(mergedData)
                });

                if (!putRes.ok) {
                    console.error("Failed to update JSONBin:", await putRes.text());
                } else {
                    structuredData = mergedData;
                }
            } catch (dbError) {
                console.error("Database Error:", dbError);
            }
        }

        return res.status(200).json(structuredData);

    } catch (error) {
        console.error("Document Processing Error:", error);
        return res.status(500).json({ error: error.message || "Failed to process the payload." });
    }
}
