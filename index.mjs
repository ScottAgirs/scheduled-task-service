const Queue = require("bull");
const axios = require("axios");
const { parseLifelabs } = require("./lab-results/src/services/lifelabs-parser");
const { logToCloudWatch, initializeCloudWatchLogs } = require("./lib/cloudwatch-logger");

const BASE_LIFELABS_ENDPOINT = "http://172.31.21.126:8000/lifelabs";
const AUTH_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/auth`;
const FETCH_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/fetch-results`;
const LOGOUT_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/logout`;
const ACK_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/acknowledge`;

const LOG_STREAM_NAME = "polling";

const requestQueue = new Queue("requestQueue", {
  redis: { host: "127.0.0.1", port: 6379 }
});

const MINUTES_COUNT = 5;
const INTERVAL = 1000 * 60 * MINUTES_COUNT;
export const HUMAN_READABLE_INTERVAL = INTERVAL / (1000 * 60) + " minutes";


function formatLogTimestamp(date = new Date()) {
  const time = date.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
  return `[${dateStr} :: ${time}]`;
}

async function authenticate() {
    await logToCloudWatch("⚪️ Starting authentication", "INFO", { step: "authentication_start" }, LOG_STREAM_NAME);
    
    const response = await axios.post(AUTH_ENDPOINT);
    
    if (response?.data?.status === "failed") {
        await logToCloudWatch("Authentication failed", "ERROR", { 
          step: "authentication_failed", 
          response: response?.data 
        }, LOG_STREAM_NAME);
        console.error("Authentication ERROR:", response);
        throw new Error("Authentication failed");
    }
    
    await logToCloudWatch("🟢 Authentication successful", "INFO", { 
      step: "authentication_success",
      hasSessionCookie: !!response?.data?.session_cookie,
      hasAspxAuth: !!response?.data?.aspx_auth,
      hasLp30Session: !!response?.data?.lp30_session
    }, LOG_STREAM_NAME);
    
    return response.data; // Contains session cookies
}

async function setupQueue() {
    await initializeCloudWatchLogs(LOG_STREAM_NAME);
    
    await logToCloudWatch("Setting up queue", "INFO", { 
      step: "queue_setup_start", 
      int: HUMAN_READABLE_INTERVAL 
    }, LOG_STREAM_NAME);

    // Drop existing jobs before adding a new one
    // TODO: Improve this
  const repeatableJobs = await requestQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        
        await requestQueue.removeRepeatableByKey(job.key);
    }

    await logToCloudWatch("⚪️ Removed existing repeatable jobs", "INFO", { 
      step: "queue_cleanup", 
      removedJobsCount: repeatableJobs.length 
    }, LOG_STREAM_NAME);

    requestQueue.add(
        {},
        { repeat: { every: INTERVAL } }
    );

    await logToCloudWatch("🟢 Queue setup completed", "INFO", { 
      step: "queue_setup_complete", 
      int: HUMAN_READABLE_INTERVAL 
    }, LOG_STREAM_NAME);

    requestQueue.process(async (job) => {
        const jobId = job.id || 'unknown';
        
        await logToCloudWatch("⚪️ Starting polling cycle", "INFO", { 
          step: "cycle_start", 
          jobId,
          int: HUMAN_READABLE_INTERVAL 
        }, LOG_STREAM_NAME);
        
        try {
            const { session_cookie, aspx_auth, lp30_session } = await authenticate();

            await logToCloudWatch("Fetching lab results", "INFO", { 
              step: "fetch_start", 
              jobId 
            }, LOG_STREAM_NAME);

            const response = await axios.post(FETCH_ENDPOINT, {
                session_cookie,
                aspx_auth,
                lp30_session
            });

            if (response.data.status !== "success") {
                await logToCloudWatch("🟥 Fetch request failed", "ERROR", { 
                  step: "fetch_failed", 
                  jobId,
                  status: response.data.status,
                  response: response.data 
                }, LOG_STREAM_NAME);

                return; // Exit early on fetch failure
            }

            await logToCloudWatch("⚪️ Fetch successful, starting parsing", "INFO", { 
              step: "fetch_success", 
              jobId,
              s3Key: response.data.s3_key 
            }, LOG_STREAM_NAME);
            
            parseLifelabs(response.data.s3_key);

            await logToCloudWatch("⚪️ Parsing completed, acknowledging results", "INFO", { 
              step: "parsing_complete", 
              jobId,
              s3Key: response.data.s3_key 
            }, LOG_STREAM_NAME);

            const ack = await axios.post(ACK_ENDPOINT, {
              session_cookie,
              aspx_auth,
              lp30_session,
              status: 'Positive',
            });

            await logToCloudWatch("🟢 Results acknowledged", "INFO", { 
              step: "acknowledge_success", 
              jobId,
              ackStatus: ack.data?.status 
            }, LOG_STREAM_NAME);

            await axios.post(LOGOUT_ENDPOINT, {
                session_cookie,
                aspx_auth,
                lp30_session
            });

            await logToCloudWatch("🏁🏁🏁 Polling cycle completed successfully", "INFO", { 
              step: "cycle_complete", 
              jobId 
            }, LOG_STREAM_NAME);
            console.log(`🟩 ${formatLogTimestamp()} ~ Completed.`)

        } catch (error) {
            await logToCloudWatch("🟥 Integration error occurred", "ERROR", { 
              step: "integration_error", 
              jobId,
              error: error.message,
              stack: error.stack,
              responseData: error.response?.data 
            }, LOG_STREAM_NAME);
        }
    });
}

setupQueue();

