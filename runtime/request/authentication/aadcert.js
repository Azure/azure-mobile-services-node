// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module provides a way to asynchronously get AAD certs to validate AAD JWTs

var LoginHandler = require('../loginhandler.js');
var certCacheHelper = require('./certcachehelper');

exports = module.exports = AadCert;

function AadCert(logger, loginEndPoint) {
    this.logger = logger;
    this.loginEndPoint = loginEndPoint;
    this.minRefreshIntervalMinutes = 5;
}

// This method returns certs if they are cached. If not cached, it retrieves them from Aad
// and caches them. If callback is passed in, certs are returned via the callback.
// Callers can force a cache refresh by specifying refresh = true via the options.
AadCert.prototype.getCerts = function (callback, options) {
    if (!callback) {
        throw new Error("AadCert.getCerts requires a callback");
    }

    options = options || {};

    if (this.certs) {
        var shouldRefresh = options.refresh && certCacheHelper.refreshIntervalExpired(this.minRefreshIntervalMinutes, this.lastRefresh);
        if (!shouldRefresh) {
            // returned the cached certs
            callback(null, this.certs);
            return;
        }
    }

    var requestOptions = {
        host: this.loginEndPoint,
        path: '/common/discovery/keys',
        method: 'GET'
    };

    var self = this;

    // Make call to get the certs
    LoginHandler.makeSecureRequest(requestOptions, null, (error, res, body) => {
        var result = null;
        // Ensure that the request was successful
        if (!error && res.statusCode !== 200) {
            error = new Error('Bad HTTP status code ' + res.statusCode);
        }

        if (error) {
            callback(new Error('Error retrieving AAD public certificates. ' + error), null);
            return;
        }

        try {
            var certArray = AadCert.parseCertificates(body);

            self.certs = certArray;
            result = certArray;

            self.lastRefresh = new Date();
        } catch (e) {
            error = new Error('Error retrieving AAD public certificates. Cert schema has changed or Aadcert.js has a bug. ' + e);
            this.logger.error('aadcert.js', error);
        }

        callback(error, result);
    });
};

AadCert.parseCertificates = json => {
    var parsedKeys = JSON.parse(json);
    var certArray = [];

    for (var keyNum = 0; keyNum < parsedKeys.keys.length; keyNum++) {
        var x5TCertLabel = parsedKeys.keys[keyNum].x5t;
        certArray[keyNum] = {
            x5t: x5TCertLabel,
            certs: []
        };

        for (var certNum = 0; certNum < parsedKeys.keys[keyNum].x5c.length; certNum++) {
            certArray[keyNum].certs[certNum] = _certToPem(parsedKeys.keys[keyNum].x5c[certNum]);
        }
    }

    return certArray;
};

// Converts a certificate in string format to pem format
function _certToPem(cert) {
    cert = cert.match(/.{1,64}/g).join('\n');
    cert = '-----BEGIN CERTIFICATE-----\n' + cert;
    cert = cert + '\n-----END CERTIFICATE-----\n';
    return cert;
}