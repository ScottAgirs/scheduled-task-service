const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client } = require('./s3-client');
const { AWS_BUCKET } = process.env;

async function getSignedFileUrl(fileKey) {
  if (!fileKey) {
    return { data: null, error: 'File key is required' };
  }

  try {
    const command = new GetObjectCommand({
      Bucket: AWS_BUCKET,
      Key: fileKey
    });

    return {
      data: await getSignedUrl(s3Client, command, { expiresIn: 25200 }),
      error: null
    };
  } catch (error) {
    return { data: null, error: error.message };
  }
}

module.exports = { getSignedFileUrl };