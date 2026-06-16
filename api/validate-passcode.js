export default function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { passcode } = req.body;

  // Get passcode from environment variable
  const correctPasscode = process.env.PASSCODE;

  // Validate that passcode is provided
  if (!passcode) {
    return res.status(400).json({ error: 'Passcode is required', valid: false });
  }

  // Validate that environment variable is set
  if (!correctPasscode) {
    console.error('PASSCODE environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error', valid: false });
  }

  // Verify passcode (server-side validation)
  const isValid = passcode === correctPasscode;

  return res.status(200).json({ valid: isValid });
}
