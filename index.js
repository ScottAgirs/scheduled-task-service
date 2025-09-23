const Queue = require("bull");
const axios = require("axios");
const { parseLifelabs } = require("./lab-results/src/services/lifelabs-parser");

const BASE_LIFELABS_ENDPOINT = "http://172.31.21.126:8000/lifelabs";
const AUTH_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/auth`;
const FETCH_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/fetch-results`;
const LOGOUT_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/logout`;
const ACK_ENDPOINT = `${BASE_LIFELABS_ENDPOINT}/acknowledge`;

const requestQueue = new Queue("requestQueue", {
  redis: { host: "127.0.0.1", port: 6379 }
});

// Run every 15 minutes
const INTERVAL = 1000 * 60 * 15;


function formatLogTimestamp(date = new Date()) {
  const time = date.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString('en-CA', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  return `[${dateStr} :: ${time}]`;
}

async function authenticate() {
    const response = await axios.post(AUTH_ENDPOINT);
    
    if (response?.data?.status === "failed") {
        console.error("Authentication ERROR:", response);
        throw new Error("Authentication failed");
    }
    
    console.log(`🚀 ${formatLogTimestamp()} ~ authenticated!`)
    
    return response.data; // Contains session cookies
}

async function setupQueue() {
    // Drop existing jobs before adding a new one
    // TODO: Improve this
  const repeatableJobs = await requestQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        console.log(`⚪️ ${formatLogTimestamp()} ~ repeatableJobs ~ job.key:`, job.key)
        
        await requestQueue.removeRepeatableByKey(job.key);
    }

    requestQueue.add(
        {},
        { repeat: { every: INTERVAL } }
    );

    requestQueue.process(async (job) => {
        console.log(`🟢 ${formatLogTimestamp()} ~ requestQueue.process`);
   
        try {
            const { session_cookie, aspx_auth, lp30_session } = await authenticate();
            console.log ("⚪️ Got session cookies:", { session_cookie, aspx_auth, lp30_session });

            const response = await axios.post(FETCH_ENDPOINT, {
                session_cookie,
                aspx_auth,
                lp30_session
            });
            console.log(`⚪️ ~ setupQueue ~ response:`, response.data);

            if (response.data.status !== "success") {
                console.error("🟥 Fetch ERROR:", response);
                // TODO: Notify/log the error
            }
            
            console.log("Will parse");
            parseLifelabs(response.data.s3_key);

            console.log('Acknowledging results...');
            // const ack = await axios.post(ACK_ENDPOINT, {
            //   session_cookie,
            //   aspx_auth,
            //   lp30_session,
            //   status: 'Positive',
            // });

            // console.log(`🚀 ~ ack.data:`, ack.data);
            console.log(`⚪️ ${formatLogTimestamp()} ~ skipping acknowledge results`);

            await axios.post(LOGOUT_ENDPOINT, {
                session_cookie,
                aspx_auth,
                lp30_session
            });
        } catch (error) {
		console.error(`❌ ${formatLogTimestamp()} Integration error:`, error.response?.data || error.message);
        }
    });
}

setupQueue();

