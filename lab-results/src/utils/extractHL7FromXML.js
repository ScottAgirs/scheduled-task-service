const { DOMParser } = require('xmldom');

/**
 * Extract HL7 messages from XML string
 * @param {string} xmlData - XML data as a string
 * @returns {Promise<Array<{id: string, content: string}>>} Array of HL7 messages with their IDs
 */
function extractHL7MessagesFromXML(xmlData) {
  return new Promise((resolve, reject) => {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlData, 'text/xml');

      // Get all Message elements
      const messageElements = xmlDoc.getElementsByTagName('Message');

      // Extract HL7 messages from CDATA sections
      const hl7Messages = [];
      for (let i = 0; i < messageElements.length; i++) {
        const messageElement = messageElements[i];
        const messageId = messageElement.getAttribute('MsgID');

        // Get the content of the CDATA section
        const hl7Content = messageElement.textContent;

        if (hl7Content) {
          hl7Messages.push({
            id: messageId,
            content: hl7Content
          });
        }
      }

      resolve(hl7Messages);
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = extractHL7MessagesFromXML;