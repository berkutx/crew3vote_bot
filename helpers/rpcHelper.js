const http = require("http")
class RpcHelper {
    constructor(host, port, user, pass) {
        let auth_str = `${user}:${pass}`;
        this.authBuff = Buffer.alloc(auth_str.length, auth_str).toString('base64')
        this.host=host;
        this.port=port;
    }

    async SendPost(json) {
        let context = this;
        return new Promise((resolve, reject) => {
            let jsonStr = JSON.stringify(json);
            const httpOpts = {
                hostname: context.host,
                port: context.port,
                method: 'POST',
                headers: {
                    'Content-Type': 'test/plain',
                    'Content-Length': jsonStr.length,
                    'Authorization': 'Basic ' + context.authBuff
                }
            };
            let httpRequest = http.request(httpOpts);
            let doCall = true;
            httpRequest.on('response', function (response) {
                let responseData = '';
                response.on('data', function (data) {
                    responseData += data;
                });
                response.on('end', function () {
                    if (!doCall)
                        return; // already rejected
                    try {
                        let parsed = JSON.parse(responseData);
                        return resolve(parsed);
                    } catch (e) {
                        return reject(new Error('Failed to parse response: ' + responseData + ". err: " + e));
                    }
                });
            });
            httpRequest.on('error', function (err) {
                doCall = false;
                return reject(err);
            });
            httpRequest.end(jsonStr);
        });
    }
}
module.exports = RpcHelper