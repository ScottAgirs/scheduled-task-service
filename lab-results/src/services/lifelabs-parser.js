const axios = require('axios');

const parseEMRHL7Message = require('../utils/parseEMRHL7Message');
const extractHL7MessagesFromXML = require('../utils/extractHL7FromXML');

const { getSignedFileUrl } = require('../../lib/getSignedFileUrl');
const { uploadFileToS3 } = require('../../lib/uploadFileToS3');

const RECEIVED_RESULTS_URL = "http://172.31.7.125:80/rest/v1/lab-results/lifelabs";

const parseLifelabs = async (fileKey) => {
  // Check and validate file key
  if (!fileKey || !fileKey.endsWith('.xml')) {
    return res.status(400).json({
      error: 'Invalid file key. Only .xml files are accepted.'
    });
  }

  try {
    const { data: signedXmlUrl, error: signedXmlUrlError } = 
      await getSignedFileUrl(fileKey);

    if (signedXmlUrlError || !signedXmlUrl) {
      console.error('Error getting signed URL:', signedXmlUrlError);
      return { 
        error: signedXmlUrlError || 'Failed to get signed URL'
      };
    }

    // Download XML from S3 using signed URL
    const response = await axios.get(signedXmlUrl, {
      responseType: 'text',
      timeout: 10000 // 10-second timeout
    });
    
    if (response.status !== 200) {
      console.log(`🚀 ~ parseLifelabs ~ response:`, response)
      return { 
        error: 'Failed to download XML file from S3'
      };
    }

    // Process XML content
    const xmlData = response.data;
    const messages = await extractHL7MessagesFromXML(xmlData);
    const hl7StringOrArray = messages.map((msg) => msg.content);

    const parsedMessagesArray = Array.isArray(hl7StringOrArray)
    ? hl7StringOrArray.map((msg) => parseEMRHL7Message(msg))
    : parseEMRHL7Message(hl7StringOrArray);
    
    if (parsedMessagesArray.length > 0) {
      const jsonData = JSON.stringify({ HL7Messages: parsedMessagesArray }, null, 2);

      const uploadResult = await uploadFileToS3({
        file: jsonData,
        fileKey: `parsed/${fileKey.replace('.xml', '.json')}`,
        contentType: 'application/json'
      });

      if (uploadResult.error) {
        return {
          error: uploadResult.error.message || 'Failed to upload file to S3'
        };
      }

      const { Key: uploadKey, Bucket } = uploadResult.data;
      
      console.log(`🟢 S3 Upload complete.`)
      
      await axios.get(
        RECEIVED_RESULTS_URL,
        {
          params: {
            bucket: Bucket,
            fileKey: uploadKey,
          }
        }
      )

      return { result: parsedMessagesArray };
    }

  } catch (error) {
    console.error('Error processing request:', error);
    throw new Error('Failed to process HL7 messages');
  }
};

module.exports = { parseLifelabs };
