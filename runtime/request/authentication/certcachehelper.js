// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is a bucket for common methods used by cert caches

var jsonWebToken = require('../../jsonwebtoken');

exports = module.exports;

exports.isExpired = (expDate, now) => {
    if (!now) {
        now = new Date();
    }

    return (now > expDate);
};

exports.createExpiryDateFromHours = function (hoursInFuture, now) {
    return this.createExpiryDateFromMinutes(hoursInFuture * 60, now);
};

exports.createExpiryDateFromMinutes = (minutesInFuture, now) => {
    if (!now) {
        now = new Date();
    }

    var returnDate = new Date();
    returnDate.setTime(now.getTime() + (minutesInFuture * 60 * 1000)); // Set expiry to N minutes from now

    return returnDate;
};

exports.refreshIntervalExpired = function (minRefreshIntervalMinutes, lastRefresh) {
    // We allow a refresh only if we haven't refreshed in the
    // last minRefreshIntervalMinutes
    var notBeforeDate = this.createExpiryDateFromMinutes(minRefreshIntervalMinutes, lastRefresh);

    var now = new Date();

    return this.isExpired(notBeforeDate, now);
};

// Attempts to validate the specified token using the provided cert manager.
// If the token fails validation due to a kid/x5t lookup failure, a cert
// refresh will be performed, and the validation will be attempted once more.
exports.validateToken = (certManager, token, callback) => {
    var retry = true;

    // define a function to get the certs and validate the token,
    // so that in the case of failures we can retry
    var validateToken = options => {
        certManager.getCerts((error, certs) => {
            if (error) {
                callback(error);
                return;
            }

            try {
                var validatedToken = jsonWebToken.parse(token, certs);
                callback(null, validatedToken);
            }
            catch (e) {
                if ((e.x5tNotFound || e.kidNotFound) && retry) {
                    // If validation failed due to an invalid kid/x5t,
                    // try once again (forcing a cert refresh)
                    retry = false;
                    validateToken({ refresh: true });
                    return;
                }
                else {
                    callback(e);
                    return;
                }
            }
        }, options);
    };

    validateToken();
};
