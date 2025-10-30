const { S3Client } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT,     // http://minio:9000
  forcePathStyle: true,                  // нужно для MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});

module.exports = { s3 };