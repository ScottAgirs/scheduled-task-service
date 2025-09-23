// @ts-check

const HL7 = require('hl7-standard/src/api');
/**
 * Parses a HL7 raw string into a structured JSON object based on the EMR Interface Guide specifications.
 * Supports both British Columbia (HL7 v2.3) and Ontario (HL7 v2.3.1) formats.
 * @param {String} rawHL7String - Raw HL7 string to parse.
 * @param {Boolean} shouldRemoveEmptyFields - Flag to remove empty fields from the parsed object.
 * @param {Boolean} includeRTFContent - Flag to include RTF content in the result (for BC messages).
 * @returns {Object} Structured object with messageHeader and patients array.
 */
function parseEMRHL7Message(
  rawHL7String,
  shouldRemoveEmptyFields = true,
  includeRTFContent = false
) {
  const hl7 = new HL7(rawHL7String);
  // @ts-ignore
  hl7.transform();

  const segments = hl7.getSegments('');
  // Sort segments by index to ensure correct order for hierarchical parsing
  segments.sort((a, b) => a.index - b.index);

  // Determine message format (BC or Ontario) based on MSH segment
  // @ts-ignore
  const mshSegment = segments.find((seg) => seg.type === 'MSH');
  const isOntarioFormat =
    mshSegment &&
    mshSegment.data['MSH.12'] &&
    mshSegment.data['MSH.12'].includes('2.3.1');

  let messageHeader = null;
  let patient = null;
  let currentOrder = null;
  let currentResult = null;
  let currentNTEContext = null;
  let reportType = null;

  // Extract the Diagnostic Service Section ID early to determine report type
  const obrSegments = segments.filter((seg) => seg.type === 'OBR');
  if (obrSegments.length > 0) {
    const diagnosticService = obrSegments[0].data['OBR.24'];
    if (diagnosticService) {
      reportType = determineReportType(diagnosticService);
    }
  }

  // Check if this is an RTF or PDF report
  const isRTFReport = checkIfRTFReport(segments);
  // @ts-ignore
  const isPDFReport = checkIfPDFReport(segments, reportType);

  segments.forEach((segment) => {
    switch (segment.type) {
      case 'MSH':
        messageHeader = parseMSH(segment, isOntarioFormat);
        break;
      case 'PID':
        patient = parsePID(segment, isOntarioFormat);
        // Add metadata as properties on the patient object
        patient.sourceFormat = isOntarioFormat ? 'Ontario' : 'BC';
        if (isRTFReport || isPDFReport) {
          patient.isReportDocument = true;
          patient.documentType = isRTFReport ? 'RTF' : 'PDF';
          patient.reportType = reportType;
        }
        currentNTEContext = patient.notes;
        break;
      case 'PV1':
        if (patient && isOntarioFormat) {
          patient.location = parsePV1(segment);
        }
        break;
      case 'ORC':
        if (patient) {
          currentOrder = parseORC(segment, isOntarioFormat);
          patient.orders = patient.orders || [];
          patient.orders.push(currentOrder);
          currentResult = null;
          currentNTEContext = null;
        }
        break;
      case 'OBR':
        if (patient) {
          if (!currentOrder) {
            currentOrder = { labResults: [] };
            patient.orders = patient.orders || [];
            patient.orders.push(currentOrder);
          }
          currentResult = parseOBR(segment, isOntarioFormat);
          currentOrder.labResults = currentOrder.labResults || [];
          currentOrder.labResults.push(currentResult);
          currentNTEContext = currentResult.notes;
        }
        break;
      case 'OBX':
        if (currentResult) {
          const obx = parseOBX(
            segment,
            isOntarioFormat,
            isRTFReport,
            isPDFReport,
            includeRTFContent
          );
          currentResult.observations = currentResult.observations || [];
          currentResult.observations.push(obx);
          currentNTEContext = obx.notes;
        }
        break;
      case 'NTE':
        if (currentNTEContext) {
          currentNTEContext.push(parseNTE(segment));
        }
        break;
      default:
        // Handle other segments as needed
        break;
    }
  });

  // Create result with patients array (for compatibility with parseHL7Message)
  const result = {
    messageHeader: messageHeader || {},
    patients: patient ? [patient] : [],
    // Keep original metadata properties at the top level for backward compatibility
    isOntarioFormat: isOntarioFormat,
    isDocumentReport: isRTFReport || isPDFReport,
    reportType: reportType
  };

  if (shouldRemoveEmptyFields) {
    removeEmptyFields(result);
  }

  return result;
}

// Rest of the file remains unchanged
/**
 * Determines the report type based on the Diagnostic Service Section ID.
 * @param {String} diagnosticService - OBR-24 value
 * @returns {String} Report type category
 */
function determineReportType(diagnosticService) {
  // Map diagnostic service codes to report types according to the guide
  const reportTypeMap = {
    LAB: 'Laboratory',
    MB: 'Microbiology',
    CH: 'Chemistry',
    HM: 'Hematology',
    PAT: 'Pathology',
    RAD: 'Radiology',
    NM: 'Nuclear Medicine',
    ECG: 'Cardiology',
    TRN: 'Transcription',
    DG: 'Diagnostic Imaging',
    CD: 'Clinical Documents',
    EN: 'Notifications'
  };

  return reportTypeMap[diagnosticService] || 'Other';
}

/**
 * Checks if the message is an RTF report (British Columbia specific).
 * @param {Array} segments - Array of HL7 segments
 * @returns {Boolean} True if this is an RTF report
 */
function checkIfRTFReport(segments) {
  const obxSegments = segments.filter((seg) => seg.type === 'OBX');
  if (obxSegments.length !== 1) return false;

  const obxData = obxSegments[0].data;
  return (
    obxData['OBX.2'] === 'ED' &&
    obxData['OBX.5'] &&
    typeof obxData['OBX.5'] === 'string' &&
    // @ts-ignore
    obxData['OBX.5'].includes('\\E\\rtf1\\E')
  );
}

/**
 * Checks if the message is a PDF report.
 * @param {Array} segments - Array of HL7 segments
 * @param {String} reportType - Type of report determined from OBR.24
 * @returns {Boolean} True if this is a PDF report
 */
function checkIfPDFReport(segments, reportType) {
  if (reportType === 'Transcription' || reportType === 'Cardiology') {
    // These report types are likely PDF according to the guide
    const obxSegments = segments.filter((seg) => seg.type === 'OBX');
    if (obxSegments.length === 1) {
      const obxData = obxSegments[0].data;
      return obxData['OBX.2'] === 'ED';
    }
  }
  return false;
}

/**
 * Formats a date string from HL7 format to ISO 8601.
 * @param {String} date - Date string to format.
 * @returns {String} Formatted date string in ISO 8601 format.
 */
function formatDate(date) {
  if (!date) {
    return '';
  }

  const year = date.substring(0, 4);
  const month = date.substring(4, 6);
  const day = date.substring(6, 8);
  const hour = date.substring(8, 10) || '00';
  const minute = date.substring(10, 12) || '00';
  const second = date.substring(12, 14) || '00';

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/**
 * Parses the MSH segment.
 * @param {Object} segment - MSH segment object.
 * @param {Boolean} isOntarioFormat - Whether this is an Ontario format message.
 * @returns {Object} Parsed MSH data.
 */
function parseMSH(segment, isOntarioFormat) {
  return {
    fieldSeparator: segment.data['MSH.1'] || '|',
    encodingCharacters: segment.data['MSH.2'] || '^~\\&',
    sendingApplication: segment.data['MSH.3'] || '',
    sendingFacility: {
      namespaceID: segment.data['MSH.4']?.['MSH.4.1'] || '',
      universalID: segment.data['MSH.4']?.['MSH.4.2'] || ''
    },
    receivingApplication: segment.data['MSH.5'] || '',
    receivingFacility: segment.data['MSH.6'] || '',
    messageDateTime: formatDate(segment.data['MSH.7'] || ''),
    messageType: {
      messageCode: segment.data['MSH.9']?.['MSH.9.1'] || 'ORU',
      triggerEvent: segment.data['MSH.9']?.['MSH.9.2'] || 'R01'
    },
    messageControlId: segment.data['MSH.10'] || '',
    processingId: segment.data['MSH.11'] || 'P',
    versionId: segment.data['MSH.12'] || (isOntarioFormat ? '2.3.1' : '2.3')
  };
}

/**
 * Parses the PID segment with field names harmonized with parseHL7Message.js.
 * @param {Object} segment - PID segment object.
 * @param {Boolean} isOntarioFormat - Whether this is an Ontario format message.
 * @returns {Object} Parsed PID data.
 */
function parsePID(segment, isOntarioFormat) {
  if (isOntarioFormat) {
    return {
      patientIdExternal: Array.isArray(segment.data['PID.3'])
        ? segment.data['PID.3'].map((id) => ({
            uniqueIdentifier: id['PID.3.1'] || '',
            assigningAuthority: id['PID.3.4'] || '',
            identifierTypeCode: id['PID.3.5'] || '',
            assigningJurisdiction: id['PID.3.9'] || '',
            idVersionCode: id['PID.3.11'] || ''
          }))
        : [
            {
              uniqueIdentifier: segment.data['PID.3']?.['PID.3.1'] || '',
              assigningAuthority: segment.data['PID.3']?.['PID.3.4'] || '',
              identifierTypeCode: segment.data['PID.3']?.['PID.3.5'] || '',
              assigningJurisdiction: segment.data['PID.3']?.['PID.3.9'] || '',
              idVersionCode: segment.data['PID.3']?.['PID.3.11'] || ''
            }
          ],
      alternatePatientId: segment.data['PID.4'] || '',
      names: Array.isArray(segment.data['PID.5'])
        ? segment.data['PID.5'].map((name) => ({
            familyName: name['PID.5.1'] || '',
            givenName: name['PID.5.2'] || '',
            middleName: name['PID.5.3'] || '',
            nameType: 'L'
          }))
        : [
            {
              familyName: segment.data['PID.5']?.['PID.5.1'] || '',
              givenName: segment.data['PID.5']?.['PID.5.2'] || '',
              middleName: segment.data['PID.5']?.['PID.5.3'] || '',
              nameType: 'L'
            }
          ],
      dateOfBirth: formatDate(segment.data['PID.7'] || ''),
      sex: segment.data['PID.8'] || '',
      addresses: Array.isArray(segment.data['PID.11'])
        ? segment.data['PID.11'].map((addr) => ({
            street: addr['PID.11.1'] || '',
            otherDesignation: addr['PID.11.2'] || '',
            city: addr['PID.11.3'] || '',
            province: addr['PID.11.4'] || '',
            postalCode: addr['PID.11.5'] || '',
            country: addr['PID.11.6'] || ''
          }))
        : [],
      phoneNumbers: (Array.isArray(segment.data['PID.13'])
        ? segment.data['PID.13'].map((phone) => phone?.['PID.13.1'] || '')
        : [segment.data['PID.13']?.['PID.13.1'] || '']
      ).filter(Boolean),
      notes: []
    };
  } else {
    // BC format (HL7 v2.3)
    return {
      patientIdInternal: segment.data['PID.2'] || '',
      patientIdExternal: Array.isArray(segment.data['PID.3'])
        ? segment.data['PID.3']
        : [segment.data['PID.3'] || ''],
      alternatePatientId: segment.data['PID.4'] || '',
      names: [
        {
          familyName: segment.data['PID.5']?.['PID.5.1'] || '',
          givenName: segment.data['PID.5']?.['PID.5.2'] || '',
          middleName: segment.data['PID.5']?.['PID.5.3'] || ''
        }
      ],
      dateOfBirth: formatDate(segment.data['PID.7'] || ''),
      sex: segment.data['PID.8'] || '',
      addresses: segment.data['PID.11']
        ? [
            {
              street: segment.data['PID.11']['PID.11.1'] || '',
              city: segment.data['PID.11']['PID.11.3'] || '',
              province: segment.data['PID.11']['PID.11.4'] || '',
              postalCode: segment.data['PID.11']['PID.11.5'] || ''
            }
          ]
        : [],
      phoneNumbers: [segment.data['PID.13'] || ''],
      notes: []
    };
  }
}

/**
 * Parses the PV1 segment (Ontario specific).
 * @param {Object} segment - PV1 segment object.
 * @returns {Object} Parsed PV1 data.
 */
function parsePV1(segment) {
  return {
    patientClass: segment.data['PV1.2'] || '',
    patientLocationId: segment.data['PV1.3'] || ''
  };
}

/**
 * Parses the ORC segment.
 * @param {Object} segment - ORC segment object.
 * @param {Boolean} isOntarioFormat - Whether this is an Ontario format message.
 * @returns {Object} Parsed ORC data.
 */
function parseORC(segment, isOntarioFormat) {
  if (isOntarioFormat) {
    return {
      orderControl: segment.data['ORC.1'] || '',
      fillerOrderNumber: segment.data['ORC.3'] || '',
      patientIdExternal: {
        uniqueId: segment.data['ORC.4']?.['ORC.4.1'] || '',
        fillerApplicationId: segment.data['ORC.4']?.['ORC.4.2'] || ''
      },
      orderStatus: segment.data['ORC.5'] || '',
      orderControlCodeReason: segment.data['ORC.16']
        ? {
            code: segment.data['ORC.16']?.['ORC.16.1'] || '',
            reason: segment.data['ORC.16']?.['ORC.16.2'] || ''
          }
        : null,
      orderingPhysician: segment.data['ORC.12']
        ? {
            physician: segment.data['ORC.12']?.['ORC.12.1'] || '',
            physicianName: segment.data['ORC.12']?.['ORC.12.2'] || '',
            familyName: segment.data['ORC.12']?.['ORC.12.2'] || '',
            firstInitial: segment.data['ORC.12']?.['ORC.12.3'] || ''
          }
        : {},
      labResults: []
    };
  } else {
    // BC Format
    return {
      orderControl: segment.data['ORC.1'] || '',
      fillerOrderNumber: segment.data['ORC.3'] || '',
      patientIdExternal: {
        uniqueId:
          segment.data['ORC.4']?.['ORC.4.1'] || segment.data['ORC.4'] || '',
        fillerApplicationId: segment.data['ORC.4']?.['ORC.4.2'] || ''
      },
      orderStatus: segment.data['ORC.5'] || '',
      orderingPhysician: segment.data['ORC.12']
        ? {
            physician: segment.data['ORC.12']?.['ORC.12.1'] || '',
            physicianName: segment.data['ORC.12']?.['ORC.12.2'] || '',
            familyName: segment.data['ORC.12']?.['ORC.12.2'] || '',
            firstInitial: segment.data['ORC.12']?.['ORC.12.3'] || ''
          }
        : {},
      labResults: []
    };
  }
}

/**
 * Parses the OBR segment.
 * @param {Object} segment - OBR segment object.
 * @param {Boolean} isOntarioFormat - Whether this is an Ontario format message.
 * @returns {Object} Parsed OBR data.
 */
function parseOBR(segment, isOntarioFormat) {
  const baseObj = {
    placerOrderNumber: segment.data['OBR.2'] || '',
    fillerOrderNumber: segment.data['OBR.3'] || '',
    universalServiceId: {
      gdmlTestCode: segment.data['OBR.4']?.['OBR.4.1'] || '',
      testName: segment.data['OBR.4']?.['OBR.4.2'] || ''
    },
    requestedDateTime: formatDate(segment.data['OBR.6'] || ''),
    collectionDateTime: formatDate(segment.data['OBR.7'] || ''),
    specimenReceivedDateTime: formatDate(segment.data['OBR.14'] || ''),
    orderingPhysician: segment.data['OBR.16']
      ? {
          physician: segment.data['OBR.16']?.['OBR.16.1'] || '',
          physicianName: segment.data['OBR.16']?.['OBR.16.2'] || '',
          familyName: segment.data['OBR.16']?.['OBR.16.2'] || '',
          firstInitial: segment.data['OBR.16']?.['OBR.16.3'] || ''
        }
      : {},
    reportedDateTime: formatDate(segment.data['OBR.22'] || ''),
    diagnosticServiceSectionId: segment.data['OBR.24'] || '',
    resultStatus: segment.data['OBR.25'] || '',
    resultCopiesTo: segment.data['OBR.28']
      ? Array.isArray(segment.data['OBR.28'])
        ? segment.data['OBR.28'].map((copyTo) => ({
            idNumber: copyTo?.['OBR.28.1'] || '',
            familyName: copyTo?.['OBR.28.2'] || '',
            givenName: copyTo?.['OBR.28.3'] || '',
            assigningFacility: copyTo?.['OBR.28.14'] || ''
          }))
        : [
            {
              idNumber: segment.data['OBR.28']?.['OBR.28.1'] || '',
              familyName: segment.data['OBR.28']?.['OBR.28.2'] || '',
              givenName: segment.data['OBR.28']?.['OBR.28.3'] || '',
              assigningFacility: segment.data['OBR.28']?.['OBR.28.14'] || ''
            }
          ]
      : [],
    observations: [],
    notes: []
  };

  if (isOntarioFormat) {
    baseObj.fillerOrderSource = segment.data['OBR.3']?.['OBR.3.2'] || '';
  }

  return baseObj;
}

/**
 * Parses the OBX segment.
 * @param {Object} segment - OBX segment object.
 * @param {Boolean} isOntarioFormat - Whether this is an Ontario format message.
 * @param {Boolean} isRTFReport - Whether this is an RTF report.
 * @param {Boolean} isPDFReport - Whether this is a PDF report.
 * @param {Boolean} includeRTFContent - Whether to include the RTF content.
 * @returns {Object} Parsed OBX data.
 */
function parseOBX(
  segment,
  isOntarioFormat,
  isRTFReport,
  isPDFReport,
  includeRTFContent
) {
  const baseObj = {
    setId: segment.data['OBX.1'] || '',
    valueType: segment.data['OBX.2'] || '',
    observationIdentifier: {
      identifier: segment.data['OBX.3']?.['OBX.3.1'] || '',
      text: segment.data['OBX.3']?.['OBX.3.2'] || '',
      codingSystem: segment.data['OBX.3']?.['OBX.3.3'] || ''
    },
    observationSubId: segment.data['OBX.4'] || '',
    observationResults: processObservationValue(
      segment.data['OBX.5'],
      isRTFReport,
      isPDFReport,
      includeRTFContent
    ),
    units: segment.data['OBX.6'] || '',
    referenceRange: segment.data['OBX.7'] || '',
    abnormalFlags: segment.data['OBX.8'] || '',
    observationResultStatus: segment.data['OBX.11'] || '',
    dateTimeOfObservation: formatDate(segment.data['OBX.14'] || ''),
    notes: []
  };

  // Ontario specific adjustments
  if (isOntarioFormat) {
    const addressArray = segment.data['OBX.15']?.['OBX.15.2']?.slice(1);
    baseObj.producersId = {
      id: segment.data['OBX.15']?.['OBX.15.1'] || '',
      name: segment.data['OBX.15']?.['OBX.15.2']?.[0] || '',
      address: addressArray
        ? {
            street: addressArray[0] || '',
            apt: addressArray[1] || '',
            city: addressArray[2] || '',
            province: addressArray[3] || '',
            postalCode: addressArray[4] || '',
            country: addressArray[5] || ''
          }
        : {}
    };
  }

  return baseObj;
}

/**
 * Processes the observation value based on the type of report
 * @param {any} value - The raw OBX.5 value
 * @param {Boolean} isRTFReport - Whether this is an RTF report
 * @param {Boolean} isPDFReport - Whether this is a PDF report
 * @param {Boolean} includeRTFContent - Whether to include RTF content
 * @returns {any} Processed observation value
 */
function processObservationValue(
  value,
  isRTFReport,
  isPDFReport,
  includeRTFContent
) {
  if (!value) return '';

  if (isRTFReport) {
    // For RTF reports
    // @ts-ignore
    if (typeof value === 'string' && value.includes('\\E\\rtf1\\E')) {
      return includeRTFContent ? value : 'RTF_CONTENT_AVAILABLE';
    }
  }

  if (isPDFReport) {
    // For PDF reports
    // @ts-ignore
    if (typeof value === 'string' && value.includes('ED')) {
      return 'PDF_CONTENT_AVAILABLE';
    }
  }

  // Handle regular values
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        return typeof item === 'object'
          ? item['OBX.5.1'] || item['OBX.5.2'] || ''
          : item || '';
      })
      .filter(Boolean);
  }

  return typeof value === 'object'
    ? value['OBX.5.1'] || value['OBX.5.2'] || ''
    : value || '';
}

/**
 * Parses the NTE segment.
 * @param {Object} segment - NTE segment object.
 * @returns {Object} Parsed NTE data.
 */
function parseNTE(segment) {
  return {
    setId: segment.data['NTE.1'] || '',
    sourceOfComment: segment.data['NTE.2'] || '',
    comment: segment.data['NTE.3'] || ''
  };
}

/**
 * Removes empty fields from an array or object recursively.
 * @param {Array|Object} arrayOrObject - Array or object to remove empty fields from.
 * @returns {void}
 */
function removeEmptyFields(arrayOrObject) {
  if (Array.isArray(arrayOrObject)) {
    arrayOrObject.forEach((item) => {
      removeEmptyFields(item);
    });
  } else if (typeof arrayOrObject === 'object' && arrayOrObject !== null) {
    for (const key in arrayOrObject) {
      if (
        arrayOrObject[key] === null ||
        arrayOrObject[key] === undefined ||
        arrayOrObject[key] === ''
      ) {
        delete arrayOrObject[key];
      } else {
        removeEmptyFields(arrayOrObject[key]);
      }
    }
  }
}

module.exports = parseEMRHL7Message;
