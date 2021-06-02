const fetch = require('node-fetch');

exports.handler = async (event) => {
    // Init response
    let response = {
        headers: { 'Content-Type': 'application/json' }
    };

    try {
        // Make sure a domain and job id have been provided
        if (!event?.queryStringParameters?.domain || !event?.queryStringParameters?.jobId) {
            throw new LambdaException('No RMK instance domain and/or no jobId given', 422);
        }
        else if (!/^\d+$/.test(event.queryStringParameters.jobId)) {
            throw new LambdaException('jobId may only contain numbers', 422);
        }

        const domain = event.queryStringParameters.domain;
        const jobId = event.queryStringParameters.jobId;

        const rmkDetails = await fetchRmkDetails(domain);
        const reqId = await getReqId(domain, rmkDetails, jobId);

        response.statusCode = 200;
        response.headers['Cache-Control'] = `public, max-age=${process.env.CACHE_TTL || 3600}`;
        response.body = JSON.stringify({
            domain: domain,
            jobId: jobId,
            ...rmkDetails,
            reqId: reqId
        });
    } catch (err) {
        // Use status code from error or fallback to returning HTTP/500
        if (err.statusCode) {
            response.statusCode = err.statusCode;
        }
        else {
            response.statusCode = 500;
        }
        response.body = JSON.stringify({ errors: [err.message] });
    }

    return response;
};

async function fetchRmkDetails(domain) {
    const resp = await fetch(`https://${domain}/errorpage/?errortype=Exception`);
    const html = await resp.text();

    // Extract company id
    const companyIdRegex = /"ssoCompanyId"\s+: '(.*?)'/;
    const companyIdResult = companyIdRegex.exec(html);

    if (!companyIdResult) {
        throw new LambdaException('No RMK instance found at given domain', 422);
    }

    // Extract crsf token
    const tokenRegex = /"X-CSRF-Token"\s+: "(.*?)"/;
    const tokenResult = tokenRegex.exec(html);

    if (!tokenResult) {
        throw new LambdaException('Failed to find X-CSRF-Token');
    }

    return {
        companyId: companyIdResult[1],
        csrfToken: tokenResult[1],
        cookie: resp.headers.raw()['set-cookie'].find((elem) => elem.includes('JSESSIONID')).split(';', 2)[0]
    };
}

async function getReqId(domain, rmkDetails, jobId) {
    const body = JSON.stringify({
        context: {
            action: 'apply',
            jobID: jobId
        }
    });
    const headers = {
        Cookie: rmkDetails.cookie,
        'X-CSRF-Token': rmkDetails.csrfToken,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    const resp = await fetch(`https://${domain}/services/cas/createpayload/`, {
        method: 'POST',
        body: body,
        headers: headers
    });

    if (resp.status == 410) {
        throw new LambdaException('No req id returned by RMK instance', 404);
    }
    else if (resp.status != 200) {
        throw new LambdaException('Failed to retrieve req id');
    }

    const payload = await resp.json();

    return payload.career_job_req_id;
}

function LambdaException(message, statusCode = 500) {
    this.message = message;
    this.statusCode = statusCode;

    if ('captureStackTrace' in Error) {
        Error.captureStackTrace(this, LambdaException);
    }
    else {
        this.stack = (new Error()).stack;
    }
}

LambdaException.prototype = Object.create(Error.prototype);
LambdaException.prototype.name = 'LambdaException';
LambdaException.prototype.constructor = LambdaException;
