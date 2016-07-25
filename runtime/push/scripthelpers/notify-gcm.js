// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module supports sending push notifications to Android clients using 
// Google Cloud Messaging

var dpush = require('dpush'),
    notify = require('./notify'),
    resources = require('../../resources');

exports.createGcmContext = function (googleApiKey) {

    var result = {};

    // transform the dpush.send and dpush.sendAdvanced methods

    // gcm.send(recipiendId, message, [options]) -> dpush.send(googleApiKey, recipientId, message, callback):
    result.send = notify.createWrapper(dpush, 'send', 2, 'gcm', null, null, true, true, function (args) {
        if (!googleApiKey) {
            throw new Error(resources.googleApiKeyMissing);
        }

        if (args.length < 2) {
            throw new Error('The send method requires 2 parameters: the recipientId(s) and message content.');
        }

        if (!Array.isArray(args[0]) && typeof args[0] !== 'string') {
            throw new Error('The send method requires the first parameter to be a string recipient Id or an array or recipient Ids.');
        }

        if (args[1] !== undefined && typeof (args[1]) !== 'string' && typeof (args[1]) !== 'object') {
            throw new Error('The send method requires the second parameter to be a string or an object with string key value pairs.');
        }

        args.unshift(googleApiKey);
    });
    

    // gcm.sendAdvanced(content, retryCount, [options]) -> dpush.sendAdvanced(googleApiKey, content, retryCount, callback):
    result.sendAdvanced = notify.createWrapper(dpush, 'sendAdvanced', 2, 'gcm', null, null, true, true, function (args) {
        if (!googleApiKey) {
            throw new Error(resources.googleApiKeyMissing);
        }

        if (args.length < 2) {
            throw new Error('The sendAdvanced method requires 2 parameters: the content object and retryCount.');
        }

        if (typeof args[0] !== 'object') {
            throw new Error('The sendAdvanced method requires the first parameter to be a content object.');
        }

        if (isNaN(args[1]) || args[1] < 0 ) {
            throw new Error('The sendAdvanced method requires the second parameter to be retryCount specified as a non-negative integer.');
        }

        args.unshift(googleApiKey);
    });

    return result;
};