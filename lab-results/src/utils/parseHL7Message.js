// @ts-check
const HL7 = require('hl7-standard/src/api');

/**
 * Parses a HL7 raw string into a structured JSON object based on GDML HL7 specification v1.01.005c.
 * @param {String} rawHL7String - Raw HL7 string to parse.
 * @param {Boolean} shouldRemoveEmptyFields - Flag to remove empty fields from the parsed object.
 * @returns {Object} Structured object with messageHeader and patients.
 */
function parseHL7Message(rawHL7String, shouldRemoveEmptyFields = true) {
  const hl7 = new HL7(rawHL7String);
  hl7.transform();

  const segments = hl7.getSegments('');
  // Sort segments by index to ensure correct order for hierarchical parsing
  segments.sort((a, b) => a.index - b.index);

  let messageHeader = null;
  const patients = [];
  let currentPatient = null;
  let currentOrder = null;
  let currentLabResult = null;
  let currentNTEContext = null;

  segments.forEach((segment) => {
    switch (segment.type) {
      case 'MSH':
        messageHeader = parseMSH(segment);
        break;
      case 'PID':
        currentPatient = parsePID(segment);
        patients.push(currentPatient);
        currentOrder = null;
        currentLabResult = null;
        currentNTEContext = currentPatient.notes;
        break;
      case 'ZDR':
        if (currentPatient) {
          currentPatient.zdrs = currentPatient.zdrs || [];
          currentPatient.zdrs.push(parseZDR(segment));
        }
        break;
      case 'ZEX':
        if (currentPatient) {
          currentPatient.exceptions = currentPatient.exceptions || [];
          currentPatient.exceptions.push(parseZEX(segment));
        }
        break;
      case 'ZTX':
        if (currentPatient) {
          currentPatient.forensicToxicologyOrders =
            currentPatient.forensicToxicologyOrders || [];
          currentPatient.forensicToxicologyOrders.push(parseZTX(segment));
        }
        break;
      case 'ZCT':
        if (currentPatient) {
          currentPatient.clinicalTrialsOrders =
            currentPatient.clinicalTrialsOrders || [];
          currentPatient.clinicalTrialsOrders.push(parseZCT(segment));
        }
        break;
      case 'ZCY':
        if (currentPatient) {
          currentPatient.cytologyOrders = currentPatient.cytologyOrders || [];
          currentPatient.cytologyOrders.push(parseZCY(segment));
        }
        break;
      case 'ZPI':
        if (currentPatient) {
          currentPatient.privateInsuranceOrders =
            currentPatient.privateInsuranceOrders || [];
          currentPatient.privateInsuranceOrders.push(parseZPI(segment));
        }
        break;
      case 'ORC':
        if (currentPatient) {
          currentOrder = parseORC(segment);
          currentPatient.orders = currentPatient.orders || [];
          currentPatient.orders.push(currentOrder);
          currentLabResult = null;
          currentNTEContext = null;
        }
        break;
      case 'OBR':
        if (currentPatient) {
          if (!currentOrder) {
            currentOrder = { labResults: [] };
            currentPatient.orders = currentPatient.orders || [];
            currentPatient.orders.push(currentOrder);
          }
          currentLabResult = parseOBR(segment);
          currentOrder.labResults.push(currentLabResult);
          currentNTEContext = currentLabResult.notes;
        }
        break;
      case 'OBX':
        if (currentLabResult) {
          const obx = parseOBX(segment);
          currentLabResult.observations = currentLabResult.observations || [];
          currentLabResult.observations.push(obx);
          currentNTEContext = obx.notes;
        }
        break;
      case 'NTE':
        if (currentNTEContext) {
          currentNTEContext.push(parseNTE(segment));
        }
        break;
      default:
        break;
    }
  });

  const result = {
    messageHeader: messageHeader || {},
    patients: patients.length > 0 ? patients : []
  };

  if (shouldRemoveEmptyFields) {
    removeEmptyFields(result);
  }

  return result;
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
  } else if (typeof arrayOrObject === 'object') {
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
/**
 * Formats a date string from HL7 format to ISO 8601.
 *
 * @param {String} date - Date string to format.
 * @returns {String} Formatted date string in ISO 8601 format.
 *
 * @example
 * formatDate('20190709151359'); // '2019-07-09T15:13:59'
 * formatDate('201907091513'); // '2019-07-09T15:13:00'
 * formatDate('20190709'); // '2019-07-09T00:00:00'
 * formatDate(''); // ''
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

// ** Denotes fields that are defined as place holders only are NOT being populated or supported
// §  Denotes fields are supported in Winnipeg LIS only
// ¥  Denotes fields are supported in Ontario LIS only

/**
 * Parses the MSH segment.
 * @param {Object} segment - MSH segment object.
 * @returns {Object} Parsed MSH data.
 */
function parseMSH(segment) {
  return {
    fieldSeparator: segment.data['MSH.1'] || '|', // MSH-1
    encodingCharacters: segment.data['MSH.2'] || '^~\\&', // MSH-2
    sendingApplication: segment.data['MSH.3'] || '', // MSH-3
    sendingFacility: segment.data['MSH.4'] || '', // MSH-4 (§)
    receivingApplication: segment.data['MSH.5'] || '', // MSH-5 (§)
    receivingFacility: segment.data['MSH.6'] || '', // MSH-6 (§)
    messageDateTime: formatDate(segment.data['MSH.7'] || ''), // MSH-7
    security: segment.data['MSH.8'] || null, // MSH-8 (**)
    // `messageType` in the spec is marked as 98 which may be a printing mistake (§9) (Requires clarification)
    messageType: {
      // MSH-9 (§ subfields)
      messageCode: segment.data['MSH.9']?.['MSH.9.1'] || 'ORU', // MSH-9.1
      triggerEvent: segment.data['MSH.9']?.['MSH.9.2'] || 'R01' // MSH-9.2
    },
    messageControlId: segment.data['MSH.10'] || '', // MSH-10 (§)
    processingId: segment.data['MSH.11'] || 'P', // MSH-11
    versionId: segment.data['MSH.12'] || '2.3', // MSH-12
    sequenceNumber: segment.data['MSH.13'] || null, // MSH-13 (**)
    continuationPointer: segment.data['MSH.14'] || null, // MSH-14 (**)
    acceptAcknowledgementType: segment.data['MSH.15'] || null, // MSH-15 (**)
    applicationAcknowledgementType: segment.data['MSH.16'] || null, // MSH-16 (**)
    countryCode: segment.data['MSH.17'] || null, // MSH-17 (**)
    characterSet: segment.data['MSH.18'] || null, // MSH-18 (**)
    principalLanguageOfMessage: segment.data['MSH.19'] || null // MSH-19 (**)
  };
}

/**
 * Parses the PID segment.
 * @param {Object} segment - PID segment object.
 * @returns {Object} Parsed PID data.
 */
function parsePID(segment) {
  const patientIdInternal = segment.data['PID.2'] || {};
  return {
    setId: segment.data['PID.1'] || '', // PID-1
    patientIdInternal: {
      // PID-2
      uniqueIdentifier: patientIdInternal['PID.2.1'] || '',
      versionNumber: patientIdInternal['PID.2.2'] || '',
      provinceCode: patientIdInternal['PID.2.3'] || '',
      clientReferenceId: patientIdInternal['PID.2.4'] || '',
      clientType: patientIdInternal['PID.2.5'] || '',
      assigningAuthority: patientIdInternal['PID.2.6'] || '',
      jurisdiction: patientIdInternal['PID.2.7'] || ''
    },
    patientIdExternal: (Array.isArray(segment.data['PID.3']) // PID-3
      ? segment.data['PID.3']
      : [segment.data['PID.3'] || {}]
    ).map((id) => ({
      uniqueIdentifier: id['PID.3.1'] || '',
      assigningFacility: {
        authority: id['PID.3.4']?.['PID.3.4.1'] || '', // 4-1 (§)
        identifierType: id['PID.3.4']?.['PID.3.4.2'] || '', // 4-2 (§)
        facilityId: id['PID.3.4']?.['PID.3.4.3'] || '' // 4-3 (§)
      }
    })),
    alternateExternalPatientId: segment.data['PID.4'] || null, // PID-4 (§)
    names: segment.data['PID.5'] // PID-5 (repeating)
      ? (Array.isArray(segment.data['PID.5'])
          ? segment.data['PID.5']
          : [segment.data['PID.5']]
        ).map((name) => ({
          familyName: name?.['PID.5.1'] || '',
          givenName: name?.['PID.5.2'] || '',
          middleName: name?.['PID.5.3'] || ''
        }))
      : [],
    mothersMaidenName: segment.data['PID.6'] || null, // PID-6 (§)
    dateOfBirth: formatDate(segment.data['PID.7'] || ''), // PID-7
    sex: segment.data['PID.8'] || '', // PID-8
    patientAlias: segment.data['PID.9'] || null, // PID-9 (**)
    race: segment.data['PID.10'] || null, // PID-10 (**)
    addresses: segment.data['PID.11'] // PID-11 (repeating)
      ? (Array.isArray(segment.data['PID.11'])
          ? segment.data['PID.11']
          : [segment.data['PID.11']]
        ).map((addr) => ({
          street: addr['PID.11.1'] || '',
          apt: addr['PID.11.2'] || '',
          city: addr['PID.11.3'] || '',
          province: addr['PID.11.4'] || '',
          postalCode: addr['PID.11.5'] || '',
          country: addr['PID.11.6'] || '' // §6
        }))
      : [],
    countyCode: segment.data['PID.12'] || null, // PID-12 (**)
    phoneNumbers: segment.data['PID.13'] // PID-13 (repeating)
      ? (Array.isArray(segment.data['PID.13'])
          ? segment.data['PID.13']
          : [segment.data['PID.13'] || '']
        ).map((phone) => phone || '')
      : [],
    alternatePhoneNumber: segment.data['PID.14'] || null, // PID-14 (**)
    primaryLanguage: segment.data['PID.15'] || null, // PID-15 (**)
    maritalStatus: segment.data['PID.16'] || null, // PID-16 (**)
    religion: segment.data['PID.17'] || null, // PID-17 (**)
    patientAccountNumber: segment.data['PID.18'] || null, // PID-18 (**)
    ssnNumber: segment.data['PID.19'] || null, // PID-19 (**)
    driversLicenseNumber: segment.data['PID.20'] || null, // PID-20 (**)
    mothersIdentifier: segment.data['PID.21'] || null, // PID-21 (**)
    ethnicGroup: segment.data['PID.22'] || null, // PID-22 (**)
    birthPlace: segment.data['PID.23'] || null, // PID-23 (**)
    multipleBirthIndicator: segment.data['PID.24'] || null, // PID-24 (**)
    birthOrder: segment.data['PID.25'] || null, // PID-25 (**)
    citizenship: segment.data['PID.26'] || null, // PID-26 (**)
    veteransMedicalStatus: segment.data['PID.27'] || null, // PID-27 (**)
    nationalityCode: segment.data['PID.28'] || null, // PID-28 (**)
    patientDeathDateTime: formatDate(segment.data['PID.29'] || null), // PID-29 (**)
    patientDeathIndicator: segment.data['PID.30'] || null, // PID-30 (**)
    notes: []
  };
}

/**
 * Parses the ZDR segment.
 * @param {Object} segment - ZDR segment object.
 * @returns {Object} Parsed ZDR data.
 */
function parseZDR(segment) {
  return {
    setId: segment.data['ZDR.1'] || '', // ZDR-1
    segmentType: segment.data['ZDR.2'] || '', // ZDR-2
    physician: {
      // ZDR-3
      physicianClientNumber: segment.data['ZDR.3']?.['ZDR.3.1'] || '',
      alternateAddressNumber: segment.data['ZDR.3']?.['ZDR.3.2'] || null,
      regulatoryBodyType: segment.data['ZDR.3']?.['ZDR.3.3'] || null,
      regulatoryBodyId: segment.data['ZDR.3']?.['ZDR.3.4'] || null
    },
    physicianName: {
      // ZDR-4
      name: segment.data['ZDR.4']?.['ZDR.4.1'] || '',
      lastName: segment.data['ZDR.4']?.['ZDR.4.2'] || '',
      middleName: segment.data['ZDR.4']?.['ZDR.4.3'] || ''
    },
    physicianAddress: {
      // ZDR-5
      addressLine1: segment.data['ZDR.5']?.['ZDR.5.1'] || '',
      addressLine2: segment.data['ZDR.5']?.['ZDR.5.2'] || '',
      city: segment.data['ZDR.5']?.['ZDR.5.3'] || '',
      province: segment.data['ZDR.5']?.['ZDR.5.4'] || '',
      postalCode: segment.data['ZDR.5']?.['ZDR.5.5'] || ''
    },
    telephone: segment.data['ZDR.6'] || '', // ZDR-6
    slotCode: segment.data['ZDR.9'] || null, // ZDR-9
    courierRoutes: {
      // ZDR-10
      route1: segment.data['ZDR.10']?.['ZDR.10.1'] || null,
      route2: segment.data['ZDR.10']?.['ZDR.10.2'] || null,
      route3: segment.data['ZDR.10']?.['ZDR.10.3'] || null
    }
  };
}

/**
 * Parses the ORC segment.
 * @param {Object} segment - ORC segment object.
 * @returns {Object} Parsed ORC data.
 */
function parseORC(segment) {
  return {
    orderControl: segment.data['ORC.1'] || '', // ORC-1
    placerOrderNumber: segment.data['ORC.2'] || null, // ORC-2 (**)
    fillerOrderNumber: segment.data['ORC.3'] || null, // ORC-3 (**)
    patientIdExternal: {
      // ORC-4 (§)
      uniqueId:
        segment.data['ORC.4']?.['ORC.4.1'] || segment.data['ORC.4'] || '',
      fillerApplicationId: segment.data['ORC.4']?.['ORC.4.2'] || ''
    },
    orderStatus: segment.data['ORC.5'] || '', // ORC-5
    responseFlag: segment.data['ORC.6'] || null, // ORC-6 (**)
    quantityTiming: segment.data['ORC.7'] || null, // ORC-7 (**)
    parentOrder: segment.data['ORC.8'] || null, // ORC-8 (**)
    transactionDateTime: formatDate(segment.data['ORC.9'] || ''), // ORC-9
    orderingPhysicianAddress: {
      // ORC-24 (§)
      streetAddress: segment.data['ORC.24']?.['ORC.24.1'] || null,
      otherDesignation: segment.data['ORC.24']?.['ORC.24.2'] || null,
      city: segment.data['ORC.24']?.['ORC.24.3'] || null,
      province: segment.data['ORC.24']?.['ORC.24.4'] || null,
      postalCode: segment.data['ORC.24']?.['ORC.24.5'] || null,
      country: segment.data['ORC.24']?.['ORC.24.6'] || null
    },
    labResults: [] // Initialize labResults array
  };
}

/**
 * Parses the OBR segment.
 * @param {Object} segment - OBR segment object.
 * @returns {Object} Parsed OBR data.
 */
function parseOBR(segment) {
  return {
    setId: segment.data['OBR.1'] || '', // OBR-1
    placerOrderNumber: segment.data['OBR.2']?.['OBR.2.1'] || '', // OBR-2 (§)
    fillerOrderNumber: {
      // OBR-3 (§)
      id: segment.data['OBR.3']?.['OBR.3.1'] || '',
      applicationId: segment.data['OBR.3']?.['OBR.3.2'] || ''
    },
    universalServiceId: {
      // OBR-4
      gdmlTestCode: segment.data['OBR.4']?.['OBR.4.1'] || '',
      testName: segment.data['OBR.4']?.['OBR.4.2'] || '',
      mohTestCode: segment.data['OBR.4']?.['OBR.4.3'] || '', // ¥
      department: segment.data['OBR.4']?.['OBR.4.4'] || '' // ¥
    },
    priority: segment.data['OBR.5'] || '', // OBR-5
    requestedDateTime: formatDate(segment.data['OBR.6'] || ''), // OBR-6
    collectionDateTime: formatDate(segment.data['OBR.7'] || ''), // OBR-7
    observationEndDateTime: formatDate(segment.data['OBR.8'] || null), // OBR-8 (**)
    collectionVolume: segment.data['OBR.9'] || null, // OBR-9 (¥)
    collectorIdentifier: segment.data['OBR.10'] || null, // OBR-10 (**)
    specimenActionFlag: segment.data['OBR.11'] || 'N', // OBR-11 (¥)
    dangerCode: segment.data['OBR.12'] || null, // OBR-12 (**)
    relevantClinicalInformation: segment.data['OBR.13'] || null, // OBR-13 (**)
    specimenReceivedDateTime: formatDate(segment.data['OBR.14'] || null), // OBR-14
    specimenSource: segment.data['OBR.15'] || null, // OBR-15 (**)
    orderingPhysician: {
      // OBR-16
      physician: segment.data['OBR.16']?.['OBR.16.1'] || '',
      physicianName: segment.data['OBR.16']?.['OBR.16.2'] || '',
      physicianOHIP: segment.data['OBR.16']?.['OBR.16.3'] || '',
      familyName: segment.data['OBR.16']?.['OBR.16.2'] || null, // § (different subfield)
      firstInitial: segment.data['OBR.16']?.['OBR.16.3'] || null // § (different subfield)
    },
    orderCallbackPhoneNumber: segment.data['OBR.17'] || null, // OBR-17 (§)
    placerField1: segment.data['OBR.18'] || null, // OBR-18 (**)
    placerField2: segment.data['OBR.19'] || null, // OBR-19 (**)
    fillerField1: segment.data['OBR.20'] || null, // OBR-20 (**)
    fillerField2: segment.data['OBR.21'] || null, // OBR-21 (**)
    reportedDateTime: formatDate(segment.data['OBR.22'] || ''), // OBR-22
    chargeToPractice: segment.data['OBR.23'] || null, // OBR-23 (**)
    diagnosticServiceSectionId: segment.data['OBR.24'] || null, // OBR-24 (**)
    resultStatus: segment.data['OBR.25'] || '', // OBR-25 (§)
    parentResult: segment.data['OBR.26'] || null, // OBR-26 (**)
    quantityTiming: segment.data['OBR.27'] || null, // OBR-27 (**)
    resultCopiesTo: segment.data['OBR.28'] // OBR-28 (§ repeating)
      ? (Array.isArray(segment.data['OBR.28'])
          ? segment.data['OBR.28']
          : [segment.data['OBR.28']]
        ).map((copy) => ({
          idNumber: copy?.['OBR.28.1'] || '',
          familyName: copy?.['OBR.28.2'] || '',
          givenName: copy?.['OBR.28.3'] || '',
          assigningFacility: copy?.['OBR.28.14'] || ''
        }))
      : [],
    parentNumber: segment.data['OBR.29'] || null, // OBR-29
    transportationMode: segment.data['OBR.30'] || null, // OBR-30 (**)
    reasonForStudy: segment.data['OBR.31'] || null, // OBR-31 (**)
    principalResultInterpreter: segment.data['OBR.32'] || null, // OBR-32 (**)
    assistantResultInterpreter: segment.data['OBR.33'] || null, // OBR-33 (**)
    technician: segment.data['OBR.34'] || null, // OBR-34 (**)
    transcriptionist: segment.data['OBR.35'] || null, // OBR-35 (**)
    scheduledDateTime: formatDate(segment.data['OBR.36'] || null), // OBR-36 (**)
    numberOfSampleContainers: segment.data['OBR.37'] || null, // OBR-37 (**)
    transportLogistics: segment.data['OBR.38'] || null, // OBR-38 (**)
    collectorsComment: segment.data['OBR.39'] || null, // OBR-39 (**)
    transportArrangementResponsibility: segment.data['OBR.40'] || null, // OBR-40 (**)
    transportArranged: segment.data['OBR.41'] || null, // OBR-41 (**)
    escortRequired: segment.data['OBR.42'] || null, // OBR-42 (**)
    plannedPatientTransport: segment.data['OBR.43'] || null, // OBR-43 (**)
    observations: [],
    notes: []
  };
}

/**
 * Parses the OBX segment.
 * @param {Object} segment - OBX segment object.
 * @returns {Object} Parsed OBX data.
 */
function parseOBX(segment) {
  return {
    setId: segment.data['OBX.1'] || '', // OBX-1
    valueType: segment.data['OBX.2'] || '', // OBX-2
    observationIdentifier: {
      // OBX-3
      gdmlTestCode: segment.data['OBX.3']?.['OBX.3.1'] || '',
      testComponentId: segment.data['OBX.3']?.['OBX.3.1']?.['OBX.3.1.2'] || '', // ¥
      testName:
        segment.data['OBX.3']?.['OBX.3.2'] ||
        segment.data['OBX.3']?.['OBX.3.3'] ||
        '', // ¥ or §
      altIdentCode: segment.data['OBX.3']?.['OBX.3.4'] || '', // §
      altIdentTxt: segment.data['OBX.3']?.['OBX.3.5'] || '', // §
      altIdentCoding: segment.data['OBX.3']?.['OBX.3.6'] || '' // §
    },
    observationSubId: segment.data['OBX.4'] || '', // OBX-4
    observationResults: segment.data['OBX.5'] // OBX-5
      ? (Array.isArray(segment.data['OBX.5'])
          ? segment.data['OBX.5']
          : [segment.data['OBX.5']]
        )
          .map((copy) =>
            String(copy?.['OBX.5.1'] || copy || '').replace('\\.br\\', '')
          )
          .filter(Boolean)
      : [],
    units: segment.data['OBX.6'] || '', // OBX-6
    referenceRange: {
      // `lines` field is a raw value, which added because the Dynacare's example does not match the specification (requires clarification)
      // OBX-7
      lines: segment.data['OBX.7']
        ? (Array.isArray(segment.data['OBX.7'])
            ? segment.data['OBX.7']
            : [segment.data['OBX.7']]
          )
            .map((copy) =>
              // @ts-ignore
              typeof copy === 'string' ? copy : Object.values(copy) || ''
            )
            // @ts-ignore
            .flat()
            .map((copy) => String(copy).replace('\\.br\\', ''))
            .filter(Boolean)
        : [],
      legacy: segment.data['OBX.7']?.['OBX.7.1'] || '',
      formatted: segment.data['OBX.7']?.['OBX.7.2'] || '',
      lowValue: segment.data['OBX.7']?.['OBX.7.3'] || '',
      highValue: segment.data['OBX.7']?.['OBX.7.4'] || ''
    },
    abnormalFlag: segment.data['OBX.8'] || '', // OBX-8
    probability: segment.data['OBX.9'] || null, // OBX-9 (**)
    observationResultStatusLegacy: segment.data['OBX.10'] || '', // OBX-10 (¥)
    observationResultStatus: segment.data['OBX.11'] || '', // OBX-11
    dateLastObservedNormalValues: formatDate(segment.data['OBX.12'] || null), // OBX-12 (**)
    userDefinedAccessChecks: segment.data['OBX.13'] || null, // OBX-13 (**)
    dateTimeOfObservation: formatDate(segment.data['OBX.14'] || null), // OBX-14 (§)
    producersId: segment.data['OBX.15'] || null, // OBX-15 (**)
    responsibleObserver: segment.data['OBX.16'] || null, // OBX-16 (**)
    observationMethod: segment.data['OBX.17'] || null, // OBX-17 (**)
    notes: []
  };
}

/**
 * Parses the NTE segment.
 * @param {Object} segment - NTE segment object.
 * @returns {Object} Parsed NTE data.
 */
function parseNTE(segment) {
  return {
    setId: segment.data['NTE.1'] || '', // NTE-1
    commentOrSource: segment.data['NTE.2'] || '', // NTE-2 (source for §)
    comment: segment.data['NTE.3'] || '', // NTE-3 (§)
    comment2: segment.data['NTE.4'] || '' // NTE-4 (§)
  };
}

/**
 * Parses the ZEX segment. (not supported in Winnipeg)
 * @param {Object} segment - ZEX segment object.
 * @returns {Object} Parsed ZEX data.
 */
function parseZEX(segment) {
  return {
    setId: segment.data['ZEX.1'] || '', // ZEX-1 (**)
    exceptionCode: segment.data['ZEX.2'] || '', // ZEX-2 (**)
    exceptionText: segment.data['ZEX.3'] || '', // ZEX-3 (**)
    pidId: segment.data['ZEX.4'] || null, // ZEX-4 (**)
    obrId: segment.data['ZEX.5'] || null, // ZEX-5 (**)
    obxId: segment.data['ZEX.6'] || null // ZEX-6 (**)
  };
}

/**
 * Parses the ZTX segment. (not supported in Winnipeg)
 * @param {Object} segment - ZTX segment object.
 * @returns {Object} Parsed ZTX data.
 */
function parseZTX(segment) {
  return {
    location: segment.data['ZTX.1'] || null, // ZTX-1
    requisitionNumber: segment.data['ZTX.2'] || null, // ZTX-2
    clientReferenceNumber: segment.data['ZTX.3'] || null, // ZTX-3
    toxicologyCollectionSite: segment.data['ZTX.4'] || null, // ZTX-4
    toxicologyCompanyNumber: segment.data['ZTX.5'] || null, // ZTX-5
    toxicologyCompanyName: segment.data['ZTX.6'] || null, // ZTX-6
    collectorsName: segment.data['ZTX.7'] || null, // ZTX-7
    collectionSiteName: segment.data['ZTX.8'] || null, // ZTX-8
    collectionSiteAddress1: segment.data['ZTX.9'] || null, // ZTX-9
    collectionSiteAddress2: segment.data['ZTX.10'] || null, // ZTX-10
    collectionSiteCity: segment.data['ZTX.11'] || null, // ZTX-11
    collectionSiteProvince: segment.data['ZTX.12'] || null, // ZTX-12
    collectionSitePostalCode: segment.data['ZTX.13'] || null, // ZTX-13
    toxicologySecondarySpecimenId: segment.data['ZTX.14'] || null // ZTX-14
  };
}

/**
 * Parses the ZCT segment. (not supported in Winnipeg)
 * @param {Object} segment - ZCT segment object.
 * @returns {Object} Parsed ZCT data.
 */
function parseZCT(segment) {
  return {
    location: segment.data['ZCT.1'] || null, // ZCT-1 (**)
    requisitionNumber: segment.data['ZCT.2'] || null, // ZCT-2 (**)
    studyNumber: segment.data['ZCT.3'] || null, // ZCT-3 (**)
    investigatorSite: segment.data['ZCT.4'] || null, // ZCT-4 (**)
    subjectNumber: segment.data['ZCT.5'] || null, // ZCT-5 (**)
    clinicalTrialSubjectInitials: segment.data['ZCT.6'] || null, // ZCT-6 (**)
    screeningNumber: segment.data['ZCT.7'] || null, // ZCT-7 (**)
    randomizationNumber: segment.data['ZCT.8'] || null, // ZCT-8 (**)
    visitNumber: segment.data['ZCT.9'] || null, // ZCT-9 (**)
    visitName: segment.data['ZCT.10'] || null, // ZCT-10 (**)
    visitType: segment.data['ZCT.11'] || null // ZCT-11 (**)
  };
}

/**
 * Parses the ZCY segment. (not supported in Winnipeg)
 * @param {Object} segment - ZCY segment object.
 * @returns {Object} Parsed ZCY data.
 */
function parseZCY(segment) {
  return {
    location: segment.data['ZCY.1'] || null, // ZCY-1 (**)
    requisitionNumber: segment.data['ZCY.2'] || null, // ZCY-2 (**)
    pathologist: segment.data['ZCY.3'] || null // ZCY-3 (**)
  };
}

/**
 * Parses the ZPI segment. (not supported in Winnipeg)
 * @param {Object} segment - ZPI segment object.
 * @returns {Object} Parsed ZPI data.
 */
function parseZPI(segment) {
  return {
    ticket: segment.data['ZPI.1'] || '', // ZPI-1
    policyNumber: segment.data['ZPI.2'] || null, // ZPI-2
    examinerCode: segment.data['ZPI.3'] || null, // ZPI-3
    insuranceType: segment.data['ZPI.4'] || null, // ZPI-4
    insuranceAmount: segment.data['ZPI.5'] || null, // ZPI-5
    dateTimeLastFoodTaken: formatDate(segment.data['ZPI.6'] || null), // ZPI-6
    insuranceAgent: segment.data['ZPI.7'] || null, // ZPI-7 (**)
    agentProvinceCode: segment.data['ZPI.8'] || null, // ZPI-8 (**)
    examiningCompany: segment.data['ZPI.9'] || null, // ZPI-9
    examiningProvinceCode: segment.data['ZPI.10'] || null, // ZPI-10
    specimenTemperature: segment.data['ZPI.11'] || null, // ZPI-11
    mensusFlag: segment.data['ZPI.12'] || null // ZPI-12
  };
}

module.exports = parseHL7Message;
