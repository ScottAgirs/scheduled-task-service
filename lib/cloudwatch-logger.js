const { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } = require("@aws-sdk/client-cloudwatch-logs");

const LOG_GROUP_NAME = "prod/logs/lifelabs";
const ERROR_LOG_GROUP_NAME = "prod/errors/lifelabs";

const cloudWatchLogs = new CloudWatchLogsClient({ region: process.env.AWS_REGION || "ca-central-1" });

async function logToCloudWatch(message, level = "INFO", additionalData = {}, streamName = "drain") {
  try {
    const timestamp = Date.now();
    const logEvent = {
      timestamp,
      message: `${message} 
      ---
      ${JSON.stringify({
        timestamp: new Date(timestamp).toISOString(),
        level,
        service: additionalData.service || "lifelabs",
        ...additionalData
      })}`
    };

    // Use error log group for ERROR level logs, regular log group for others
    const logGroupName = level === "ERROR" ? ERROR_LOG_GROUP_NAME : LOG_GROUP_NAME;

    const putLogEventsCommand = new PutLogEventsCommand({
      logGroupName,
      logStreamName: streamName,
      logEvents: [logEvent]
    });

    await cloudWatchLogs.send(putLogEventsCommand);
  } catch (error) {
    console.error("Failed to log to CloudWatch:", error.message);
  }
}

async function initializeCloudWatchLogs(streamName = "default") {
  try {
    // Create both log groups if they don't exist
    const logGroups = [LOG_GROUP_NAME, ERROR_LOG_GROUP_NAME];
    
    for (const logGroupName of logGroups) {
      try {
        await cloudWatchLogs.send(new CreateLogGroupCommand({
          logGroupName
        }));
      } catch (error) {
        if (error.name !== "ResourceAlreadyExistsException") {
          throw error;
        }
      }

      // Create log stream in each group if it doesn't exist
      try {
        await cloudWatchLogs.send(new CreateLogStreamCommand({
          logGroupName,
          logStreamName: streamName
        }));
      } catch (error) {
        if (error.name !== "ResourceAlreadyExistsException") {
          throw error;
        }
      }
    }

    console.log(`✅ CW initialized.`);
  } catch (error) {
    console.error("Failed to initialize CloudWatch logging:", error.message);
  }
}

module.exports = {
  logToCloudWatch,
  initializeCloudWatchLogs
};
