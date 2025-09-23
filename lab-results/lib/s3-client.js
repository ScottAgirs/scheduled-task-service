// Load env variables from .env file
require('dotenv').config();
const { S3Client } = require('@aws-sdk/client-s3');

const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_BUCKET } =
  process.env;
console.log(`🚀 ~ { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_BUCKET }:`, { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_BUCKET })

const missingVars = Object.entries({
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  AWS_BUCKET,
})
  .filter(([_key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  const error = new Error(
    `Missing environment variables: ${missingVars.join(', ')}`,
  );

  throw error;
}

const s3Client = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: AWS_REGION,
});

module.exports = { s3Client };