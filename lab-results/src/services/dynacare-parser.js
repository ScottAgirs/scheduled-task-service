const parseHL7Message = require('../utils/parseHL7Message');
const extractHL7MessagesFromXML = require('../utils/extractHL7FromXML');

const handleDynacare = async (req, res) => {
  try {
    const { rawHL7String } = req.body;
    const file = req.file;

    if (!file && !rawHL7String) {
      return res
        .status(400)
        .json({ error: 'Either file upload or rawHL7String is required.' });
    }

    let hl7StringOrArray;

    if (file) {
      if (
        file.mimetype === 'application/xml' ||
        file.originalname.endsWith('.xml')
      ) {
        // Use buffer directly instead of reading from path
        const xmlData = file.buffer.toString('utf8');
        const messages = await extractHL7MessagesFromXML(xmlData);
        hl7StringOrArray = messages.map((msg) => msg.content);
      } else if (
        file.mimetype === 'application/octet-stream' ||
        file.mimetype === 'text/plain' ||
        file.originalname.endsWith('.hl7')
      ) {
        // Use buffer directly
        hl7StringOrArray = file.buffer.toString('utf8');
      } else {
        return res.status(400).json({
          error: 'Invalid file type. Only .hl7 and .xml files are accepted.'
        });
      }
    } else if (rawHL7String) {
      hl7StringOrArray = rawHL7String;
    }

    // Parse the HL7 message(s)
    const result = Array.isArray(hl7StringOrArray)
      ? hl7StringOrArray.map((msg) => parseHL7Message(msg))
      : parseHL7Message(hl7StringOrArray);

    return res.status(200).json({ result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = { handleDynacare };
