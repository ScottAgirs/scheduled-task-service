const Queue = require("bull");
const axios = require("axios");
const { parseLifelabs } = require("./lab-results/src/services/lifelabs-parser");
const { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } = require("@aws-sdk/client-cloudwatch-logs");

const BASE_LIFELABS_ENDPOINT = "http://172.31.21.126:8000/lifelabs";
const AUTH_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/auth`;
const FETCH_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/fetch-results`;
const LOGOUT_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/logout`;
const ACK_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/acknowledge`;

const LOG_GROUP_NAME = "prod/logs/lifelabs";
const ERROR_LOG_GROUP_NAME = "prod/errors/lifelabs";
const LOG_STREAM_NAME = "polling";

const requestQueue = new Queue("requestQueue", {
  redis: { host: "127.0.0.1", port: 6379 }
});

const cloudWatchLogs = new CloudWatchLogsClient({ region: process.env.AWS_REGION || "ca-central-1" });

const INTERVAL = 1000 * 60 * 10; // 10 minutes


function formatLogTimestamp(date = new Date()) {
  const time = date.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
  return `[${dateStr} :: ${time}]`;
}

async function logToCloudWatch(message, level = "INFO", additionalData = {}) {
  try {
    const timestamp = Date.now();
    const logEvent = {
      timestamp,
      message: JSON.stringify({
        timestamp: new Date(timestamp).toISOString(),
        level,
        message,
        service: "lifelabs-polling",
        ...additionalData
      })
    };

    // Use error log group for ERROR level logs, regular log group for others
    const logGroupName = level === "ERROR" ? ERROR_LOG_GROUP_NAME : LOG_GROUP_NAME;

    const putLogEventsCommand = new PutLogEventsCommand({
      logGroupName,
      logStreamName: LOG_STREAM_NAME,
      logEvents: [logEvent]
    });

    await cloudWatchLogs.send(putLogEventsCommand);
  } catch (error) {
    console.error("Failed to log to CloudWatch:", error.message);
  }
}

async function initializeCloudWatchLogs() {
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
          logStreamName: LOG_STREAM_NAME
        }));
      } catch (error) {
        if (error.name !== "ResourceAlreadyExistsException") {
          throw error;
        }
      }
    }

    console.log(`✅ CloudWatch logging initialized for ${LOG_GROUP_NAME}/${LOG_STREAM_NAME} and ${ERROR_LOG_GROUP_NAME}/${LOG_STREAM_NAME}`);
  } catch (error) {
    console.error("Failed to initialize CloudWatch logging:", error.message);
  }
}

async function authenticate() {
    await logToCloudWatch("Starting authentication", "INFO", { step: "authentication_start" });
    
    const response = await axios.post(AUTH_ENDPOINT);
    
    if (response?.data?.status === "failed") {
        await logToCloudWatch("Authentication failed", "ERROR", { 
          step: "authentication_failed", 
          response: response?.data 
        });
        console.error("Authentication ERROR:", response);
        throw new Error("Authentication failed");
    }
    
    await logToCloudWatch("Authentication successful", "INFO", { 
      step: "authentication_success",
      hasSessionCookie: !!response?.data?.session_cookie,
      hasAspxAuth: !!response?.data?.aspx_auth,
      hasLp30Session: !!response?.data?.lp30_session
    });
    
    console.log(`🚀 ${formatLogTimestamp()} ~ authenticated!`)
    
    return response.data; // Contains session cookies
}

async function setupQueue() {
    await initializeCloudWatchLogs();
    
    await logToCloudWatch("Setting up queue", "INFO", { 
      step: "queue_setup_start", 
      interval: INTERVAL 
    });

    // Drop existing jobs before adding a new one
    // TODO: Improve this
  const repeatableJobs = await requestQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        console.log(`⚪️ ${formatLogTimestamp()} ~ repeatableJobs ~ job.key:`, job.key)
        
        await requestQueue.removeRepeatableByKey(job.key);
    }

    await logToCloudWatch("Removed existing repeatable jobs", "INFO", { 
      step: "queue_cleanup", 
      removedJobsCount: repeatableJobs.length 
    });

    requestQueue.add(
        {},
        { repeat: { every: INTERVAL } }
    );

    await logToCloudWatch("Queue setup completed", "INFO", { 
      step: "queue_setup_complete", 
      interval: INTERVAL 
    });

    requestQueue.process(async (job) => {
        const jobId = job.id || 'unknown';
        
        await logToCloudWatch("Starting polling cycle", "INFO", { 
          step: "cycle_start", 
          jobId,
          interval: INTERVAL 
        });
        
        console.log(`🟢 ${formatLogTimestamp()} ~ requestQueue.process`);
   
        try {
            const { session_cookie, aspx_auth, lp30_session } = await authenticate();

            await logToCloudWatch("Fetching lab results", "INFO", { 
              step: "fetch_start", 
              jobId 
            });

            const response = await axios.post(FETCH_ENDPOINT, {
                session_cookie,
                aspx_auth,
                lp30_session
            });
            console.log(`⚪️ ~ setupQueue ~ response:`, response.data);

            if (response.data.status !== "success") {
                await logToCloudWatch("Fetch request failed", "ERROR", { 
                  step: "fetch_failed", 
                  jobId,
                  status: response.data.status,
                  response: response.data 
                });
                console.error("🟥 Fetch ERROR:", response);
                return; // Exit early on fetch failure
            }
            
            await logToCloudWatch("Fetch successful, starting parsing", "INFO", { 
              step: "fetch_success", 
              jobId,
              s3Key: response.data.s3_key 
            });
            
            console.log("Will parse");
            parseLifelabs(response.data.s3_key);

            await logToCloudWatch("Parsing completed, acknowledging results", "INFO", { 
              step: "parsing_complete", 
              jobId,
              s3Key: response.data.s3_key 
            });

            console.log('Acknowledging results...');
            const ack = await axios.post(ACK_ENDPOINT, {
              session_cookie,
              aspx_auth,
              lp30_session,
              status: 'Positive',
            });

            await logToCloudWatch("Results acknowledged", "INFO", { 
              step: "acknowledge_success", 
              jobId,
              ackStatus: ack.data?.status 
            });

            console.log(`🚀 ~ ack.data:`, ack.data);
            // console.log(`⚪️ ${formatLogTimestamp()} ~ skipping acknowledge results`);

            await axios.post(LOGOUT_ENDPOINT, {
                session_cookie,
                aspx_auth,
                lp30_session
            });

            await logToCloudWatch("Polling cycle completed successfully", "INFO", { 
              step: "cycle_complete", 
              jobId 
            });

        } catch (error) {
            await logToCloudWatch("Integration error occurred", "ERROR", { 
              step: "integration_error", 
              jobId,
              error: error.message,
              stack: error.stack,
              responseData: error.response?.data 
            });
            
            console.error(`❌ ${formatLogTimestamp()} Integration error:`, error.response?.data || error.message);
        }
    });
}

setupQueue();

