const axios = require('axios');

const parseEMRHL7Message = require('../utils/parseEMRHL7Message');
const extractHL7MessagesFromXML = require('../utils/extractHL7FromXML');

const { getSignedFileUrl } = require('../../lib/getSignedFileUrl');
const { uploadFileToS3 } = require('../../lib/uploadFileToS3');
const { logToCloudWatch } = require('../../../lib/cloudwatch-logger');

const RECEIVED_RESULTS_URL = "http://172.31.7.125:80/rest/v1/lab-results/lifelabs";

const LOG_STREAM_NAME = "parser";

const parseLifelabs = async (fileKey) => {
  await logToCloudWatch("🟡 Starting Lifelabs parsing", "INFO", { 
    step: "parsing_start",
    fileKey,
    service: "lifelabs-parser" 
  }, LOG_STREAM_NAME);

  // Check and validate file key
  if (!fileKey || !fileKey.endsWith('.xml')) {
    await logToCloudWatch("🟥 Invalid file key provided", "ERROR", { 
      step: "validation_failed",
      fileKey,
      reason: "Invalid file key. Only .xml files are accepted.",
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);

    return {
      error: 'Invalid file key. Only .xml files are accepted.'
    };
  }

  await logToCloudWatch("⚪️ File key validation passed", "INFO", { 
    step: "validation_success",
    fileKey,
    service: "lifelabs-parser" 
  }, LOG_STREAM_NAME);

  try {
    await logToCloudWatch("⚪️ Getting signed S3 URL", "INFO", { 
      step: "s3_url_start",
      fileKey,
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);

    const { data: signedXmlUrl, error: signedXmlUrlError } = 
      await getSignedFileUrl(fileKey);

    if (signedXmlUrlError || !signedXmlUrl) {
      await logToCloudWatch("🟥 Failed to get signed S3 URL", "ERROR", { 
        step: "s3_url_failed",
        fileKey,
        error: signedXmlUrlError,
        service: "lifelabs-parser" 
      }, LOG_STREAM_NAME);
      
      console.error('Error getting signed URL:', signedXmlUrlError);
      return { 
        error: signedXmlUrlError || 'Failed to get signed URL'
      };
    }

    await logToCloudWatch("⚪️ S3 signed URL obtained", "INFO", { 
      step: "s3_url_success",
      fileKey,
      hasUrl: !!signedXmlUrl,
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);

    await logToCloudWatch("🟡 Downloading XML from S3", "INFO", { 
      step: "xml_download_start",
      fileKey,
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);

    // Download XML from S3 using signed URL
    const response = await axios.get(signedXmlUrl, {
      responseType: 'text',
      timeout: 10000 // 10-second timeout
    });
    
    if (response.status !== 200) {
      await logToCloudWatch("🟥 XML download failed", "ERROR", { 
        step: "xml_download_failed",
        fileKey,
        status: response.status,
        service: "lifelabs-parser" 
      }, LOG_STREAM_NAME);
      
      console.log(`🚀 ~ parseLifelabs ~ response:`, response)
      return { 
        error: 'Failed to download XML file from S3'
      };
    }

    await logToCloudWatch("⚪️ XML downloaded successfully", "INFO", { 
      step: "xml_download_success",
      fileKey,
      xmlSize: response.data?.length || 0,
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);

    await logToCloudWatch("Processing XML and extracting HL7 messages", "INFO", { 
      step: "hl7_extraction_start",
      fileKey,
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);

    // Process XML content
    const xmlData = response.data;
    const messages = await extractHL7MessagesFromXML(xmlData);
    const hl7StringOrArray = messages.map((msg) => msg.content);

    await logToCloudWatch("⚪️ HL7 messages extracted", "INFO", { 
      step: "hl7_extraction_success",
      fileKey,
      messageCount: messages.length,
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);

    await logToCloudWatch("Parsing HL7 messages", "INFO", { 
      step: "hl7_parsing_start",
      fileKey,
      messageCount: messages.length,
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);

    const parsedMessagesArray = Array.isArray(hl7StringOrArray)
    ? hl7StringOrArray.map((msg) => parseEMRHL7Message(msg))
    : parseEMRHL7Message(hl7StringOrArray);

    await logToCloudWatch("⚪️ HL7 messages parsed", "INFO", { 
      step: "hl7_parsing_success",
      fileKey,
      parsedMessageCount: parsedMessagesArray.length,
      service: "lifelabs-parser" 
    }, LOG_STREAM_NAME);
    
    if (parsedMessagesArray.length > 0) {
      await logToCloudWatch("🟡 Uploading parsed results to S3", "INFO", { 
        step: "s3_upload_start",
        fileKey,
        parsedMessageCount: parsedMessagesArray.length,
        service: "lifelabs-parser" 
      }, LOG_STREAM_NAME);

      const jsonData = JSON.stringify({ HL7Messages: parsedMessagesArray }, null, 2);
      const outputFileKey = `parsed/${fileKey.replace('.xml', '.json')}`;

      const uploadResult = await uploadFileToS3({
        file: jsonData,
        fileKey: outputFileKey,
        contentType: 'application/json'
      });

      if (uploadResult.error) {
        await logToCloudWatch("🟥 S3 upload failed", "ERROR", { 
          step: "s3_upload_failed",
          fileKey,
          outputFileKey,
          error: uploadResult.error.message,
          service: "lifelabs-parser" 
        }, LOG_STREAM_NAME);

        return {
          error: uploadResult.error.message || 'Failed to upload file to S3'
        };
      }

      const { Key: uploadKey, Bucket } = uploadResult.data;
      
      await logToCloudWatch("⚪️ S3 upload completed", "INFO", { 
        step: "s3_upload_success",
        fileKey,
        outputFileKey: uploadKey,
        bucket: Bucket,
        service: "lifelabs-parser" 
      }, LOG_STREAM_NAME);
      
      console.log(`🟢 S3 Upload complete.`)
      
      await logToCloudWatch("🚀 Sending notification to received results endpoint", "INFO", { 
        step: "notification_start",
        fileKey,
        outputFileKey: uploadKey,
        bucket: Bucket,
        endpoint: RECEIVED_RESULTS_URL,
        service: "lifelabs-parser" 
      }, LOG_STREAM_NAME);

      await axios.get(
        RECEIVED_RESULTS_URL,
        {
          params: {
            bucket: Bucket,
            fileKey: uploadKey,
          }
        }
      )

      await logToCloudWatch("⚪️ Notification sent successfully", "INFO", { 
        step: "notification_success",
        fileKey,
        outputFileKey: uploadKey,
        endpoint: RECEIVED_RESULTS_URL,
        service: "lifelabs-parser" 
      }, LOG_STREAM_NAME);

      await logToCloudWatch("🏁🏁🏁 Lifelabs parsing completed successfully", "INFO", { 
        step: "parsing_complete",
        fileKey,
        outputFileKey: uploadKey,
        parsedMessageCount: parsedMessagesArray.length,
        service: "lifelabs-parser" 
      }, LOG_STREAM_NAME);

      return { result: parsedMessagesArray };
    } else {
      await logToCloudWatch("⚠️ No HL7 messages found to process", "INFO", { 
        step: "no_messages_found",
        fileKey,
        service: "lifelabs-parser" 
      }, LOG_STREAM_NAME);

      return { result: [] };
    }

  } catch (error) {
    await logToCloudWatch("🟥 Lifelabs parsing error", "ERROR", { 
      step: "parsing_error",
      fileKey,
      error: error.message,
      stack: error.stack,
      service: "lifelabs-parser" 
    }, "parser");

    console.error('Error processing request:', error);
    throw new Error('Failed to process HL7 messages');
  }
};

module.exports = { parseLifelabs };
