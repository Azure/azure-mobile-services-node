// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module supports sending push notifications to iOS clients using the
// Apple Push Notification Service

var core = require('../../core'),
    resources = require('../../resources'),
    apns = require('apn'),
    notify = require('./notify'),
    fs = require('fs'),
    _ = require('underscore'),
    _str = require('underscore.string'),
    ApnConnectionFactory = require('./apnconnectionfactory');

_.mixin(_str.exports());

// Status descriptions for Apple Push error codes.  From: http://developer.apple.com/library/ios/#documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingWIthAPS/CommunicatingWIthAPS.html#//apple_ref/doc/uid/TP40008194-CH101-SW1
var statusDescriptions = {
    0: 'No errors encountered',
    1: 'Processing error',
    2: 'Missing device token',
    3: 'Missing topic',
    4: 'Missing payload',
    5: 'Invalid token size',
    6: 'Invalid topic size',
    7: 'Invalid payload size',
    8: 'Invalid token',
    255: 'None (unknown)'
};

exports.getCertLoader = function (apnsCertificatePath) {
    var pfxData = null;

    function getCertificate(action) {
        if (!pfxData) {
            pfxData = loadCertificate(apnsCertificatePath, action);
        }
        return pfxData;
    }

    return getCertificate;
};

exports.createApnsContext = function (apnsCertificatePath, apnsPassword, apnsMode) {

    var gateway = (apnsMode == 'Prod') ? 'gateway.push.apple.com' : 'gateway.sandbox.push.apple.com';

    var getCertificate = exports.getCertLoader(apnsCertificatePath);

    // We will share the connection for all push notifications
    var connectionFactory = new ApnConnectionFactory(getCertificate.bind(null, 'send notification'), apnsPassword, gateway);

    // Create just the default options for connecting to the Apple Feedback service. Apple
    // makes us create a new connection each time, so we can't share the connection like we can
    // when sending notifications. We use an 'interval' of 0 below to ensure the feedback instance
    // doesn't set it's own timer.
    var feedbackOptions = null;
    var feedbackOptionsFactory = function () {
        if (!feedbackOptions) {
            feedbackOptions = {
                pfxData: getCertificate('get APNS feedback'),
                passphrase: apnsPassword,
                address: gateway,
                batchFeedback: true,
                interval: 0
            };
        }
        return feedbackOptions;
    };

    // We wrap the actual node.js APN module APIs so that they conform better to the other push APIs by
    // creating this apnsModule object
    var apnsModule = {
        send: core.curry(exports.send, connectionFactory),
        getFeedback: core.curry(exports.getFeedback, feedbackOptionsFactory)
    };

    // Now we need to wrap all of the methods of our apnsModule so that metrics and logging are done
    // consistently across all of the notify modules.
    var result = {};
    for (var method in apnsModule) {
        // The 'getFeedback' method doesn't take any arguments (other than the optional 'options' argument);
        // The only other method, 'send', takes 2 arguments
        var argCount = (method == "getFeedback") ? 0 : 2;
        result[method] = notify.createWrapper(apnsModule, method, argCount, "apns");
    }

    return result;
};

exports.send = function (connectionFactory, deviceToken, payload, ignore, errorCallback) {
    var connection = connectionFactory.getConnection();

    if (!core.isString(deviceToken)) {
        throw new Error('The deviceToken parameter must be a UTF8 encoded hex string representation of a device token.');
    }

    if (!core.isObject(payload)) {
        throw new Error('The payload parameter must be an object.');
    }

    var notification = exports.createNotificationFromPayload(payload);

    // Create the device and add to the notification
    var device = new apns.Device(deviceToken);
    notification.device = device;

    // Create the error callback; there is no success callback because Apple doesn't
    // respond if the notification was received and validated successfully.
    notification.errorCallback = function (error) {
        if (checkCertError(error, errorCallback)) {
            return;
        }

        // If the error is just an error code from the APN module,
        // create a more detailed error from it.
        if (core.isNumber(error)) {
            var statusDescription = statusDescriptions[error.toString()];
            error = {
                statusCode: error,
                deviceToken: device.toString(),
                statusDescription: statusDescription || statusDescriptions["255"]
            };
        }

        errorCallback(error);
    };

    connection.sendNotification(notification);
};

exports.createNotificationFromPayload = function (payload) {
    var notification;

    if (payload.aps) {
        // If payload is in Apple APNS format, allow APN to do the formatting
        // Pull expiry off of the payload to ensure it isn't part of notification sent to device
        notification = new apns.Notification(_.omit(payload, 'expiry'));
    } else {
        // Otherwise, use extends to attach payload members to notification directly
        notification = new apns.Notification();
        core.extend(notification, payload);
    }

    // APN forces users to remove dash so we ensure it works when specified with dash
    if (payload['content-available']) {
        notification.contentAvailable = 1;
    }

    if (payload.expiry) {
        notification.expiry = payload.expiry;

        // Convert expiration dates into number of seconds
        if (core.isDate(notification.expiry)) {
            notification.expiry = Math.floor(notification.expiry / 1000);
        }
    }

    notification.retryLimit = 3;

    return notification;
};

exports.getFeedback = function (feedbackOptionsFactory, ignore, callback) {
    var feedbackOptions = feedbackOptionsFactory();

    var options = {};
    core.extend(options, feedbackOptions);

    // Set the feedback callback; this is the success callback
    options.feedback = function (feedback) {

        // We need to convert the feedback we get from the APN
        // module to something more user friendly
        var converted = [];
        feedback.forEach(function (item) {
            converted.push({
                deviceToken: item.device.toString(),
                timeStamp: new Date(item.time * 1000)
            });
        });

        callback(null, converted);
    };

    // Set the errorCAllback; this is the error callback
    options.errorCallback = function (error) {
        if (checkCertError(error, callback)) {
            return;
        }

        callback(error, null);
    };

    // Nothing to return here; simply creating the Feedback
    // instance will cause it to connect to the Apple Feedback service.
    new apns.Feedback(options);
};

function checkCertError(error, callback) {
    if (error.code == "ECONNRESET") {
        callback(new Error(resources.apnsCertificateError));
        return true;
    }
    return false;
}

function loadCertificate(certPath, action) {
    try {
        var pfxData = fs.readFileSync(certPath);
        return pfxData;

    } catch (e) {
        var error = new core.MobileServiceError(_.sprintf(resources.apnsCertificateMissing, action));
        throw error;
    }
}