const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

// Load environment variables from a .env file if running in development
require('dotenv').config();

// Configure Cloudinary using environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadFolder = './images'; 
const assetFolder = process.env.CLOUDINARY_ASSET_FOLDER || 'samples/ecommerce';
const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || 'zamzam';

// Supported image extensions
const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];

async function uploadImages() {
  try {
    console.log('Scanning local directory for images...');
    const files = fs.readdirSync(uploadFolder);
    
    // Filter out directories, script.js itself, and non-image files
    const imageFiles = files.filter(file => {
      const filePath = path.join(uploadFolder, file);
      const stats = fs.statSync(filePath);
      return stats.isFile() && 
             file !== 'script.js' && 
             imageExtensions.includes(path.extname(file).toLowerCase());
    });

    if (imageFiles.length === 0) {
      console.log('No image files found in the root directory.');
      return;
    }

    console.log(`Found ${imageFiles.length} image(s) to upload. Starting upload...\n`);

    const uploadedUrls = [];

    for (const file of imageFiles) {
      const filePath = path.join(uploadFolder, file);
      console.log(`Uploading: ${file}...`);

      try {
        const result = await cloudinary.uploader.upload(filePath, {
          folder: assetFolder,
          upload_preset: uploadPreset
        });

        console.log(`-> Success: ${result.secure_url}`);
        uploadedUrls.push({
          fileName: file,
          url: result.secure_url
        });
      } catch (uploadError) {
        console.error(`-> Failed to upload ${file}:`, uploadError.message);
      }
    }

    console.log('\n==============================');
    console.log('     ALL UPLOADED URLS        ');
    console.log('==============================');
    uploadedUrls.forEach((item, index) => {
      console.log(`${index + 1}. ${item.fileName} -> ${item.url}`);
    });
    console.log('==============================');

  } catch (error) {
    console.error('Error scanning directory or running uploads:', error);
  }
}

uploadImages();