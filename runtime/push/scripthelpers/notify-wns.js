// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module supports sending push notifications to Windows 8 clients using 
// Windows Notification Services

var wns = require('wns');

var notify = require('./notify');
var core = require('../../core');

exports.createWnsContext = (client_secret, client_id) => {
    var result = {};
    var accessTokenContainer = {};

    // - accessToken is not passed back to the caller throught the callback
    // - only x-wns-* HTTP response headers are returned in the result or error
    // - channel URL is passed to callbacks as part of the result or error object
    function cleanUpWnsResult(item, args) {
        if (core.isObject(item)) {
            // if a new access token had been issued in the course of sending the WNS notification,
            // cache it for subsequent use in this in memory container scoped to (client_id, client_secret)
            if (item.newAccessToken) {
                accessTokenContainer.accessToken = item.newAccessToken;
                delete item.newAccessToken;
            }

            if (typeof item.headers === 'object') {
                Object.getOwnPropertyNames(item.headers).forEach(header => {
                    if (header.toLowerCase().indexOf('x-wns-') !== 0) {
                        delete item.headers[header];
                    }
                });
            }

            // add channel information to result; the channel should be the first argument
            item.channel = args[0];
        }

        return item;
    }

    // - client_id and client_secret and provided by ZUMO
    // - accessToken, if obtained, is cached by ZUMO in memory
    function configureWnsAuth(options) {
        options.client_id = options.client_id || client_id;
        options.client_secret = options.client_secret || client_secret;
        options.accessToken = options.accessToken || accessTokenContainer.accessToken;
    }

    // transform the sendTile*, sendToast*, and sendBadge methods
    for (var method in wns) {
        if (method.indexOf('send') === 0) {
            result[method] = notify.createWrapper(wns, method, 2, 'wns', cleanUpWnsResult, configureWnsAuth);
        }
    }

    return result;
};