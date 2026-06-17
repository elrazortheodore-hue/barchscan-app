// /api/delete-image.js
import cloudinary from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  const { public_id } = req.body;
  if (!public_id) return res.status(400).json({ error: 'Missing public_id' });

  try {
    const result = await cloudinary.v2.api.delete_resources([public_id]);
    if (result.deleted && result.deleted[public_id] === 'deleted') {
      res.status(200).json({ success: true });
    } else {
      throw new Error('Deletion failed');
    }
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
}
