const { s3Client } = require('./s3-client');
const { Upload } = require('@aws-sdk/lib-storage');

const { AWS_BUCKET } = process.env;

async function uploadFileToS3({
  bucket = AWS_BUCKET,
  file,
  fileKey,
  fileType,
}) {
  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Body: file,
        Bucket: bucket,
        ContentType: fileType,
        Key: fileKey,
      },
    });

    const data = await upload.done();

    return { data, error: null };
  } catch (error) {
    const customError = {
      message: 'Error uploading file to S3',
      originalError: error,
    };

    return { data: null, error: customError };
  }
}

module.exports = { uploadFileToS3 };