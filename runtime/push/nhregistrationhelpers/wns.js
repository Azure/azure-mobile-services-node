// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the helper to assist nhregistrationhandler with Wns registration operations

var core = require('../../core'),
    _ = require('underscore');

exports = module.exports = WnsHandler;

function WnsHandler(nhRegistrationHandler) {
    this.nhRegistrationHandler = nhRegistrationHandler;
}

// Transform a javascript object fed to nhRegistrationHandler to an ordered, case sensitive javascript object ready for notificationHubService
// Format of result object:
// {
//   RegistrationId: '', --REQUIRED
//   Tags: 'tag1,tag2', --OPTIONAL
//   ChannelUri: '', --REQUIRED
//   BodyTemplate: '', --OPTIONAL--this controls whether this is a template
//   WnsHeaders: '', --OPTIONAL--additional HTTP headers that NH will pass to Wns when it sends the templated notifcation
//   TemplateName: '', --OPTIONAL (REQUIRED if BodyTemplate is provided)
//   _: --REQUIRED/UNORDERED--property bag with many optional properties, but only one is set here
//   _.ContentRootElement: --REQUIRED/UNORDERED-controls the type of the SOAP object eventually sent to notification hub
// }
WnsHandler.prototype.transformInputToNhRegistration = function (inputRegistration) {
    var registration = this.nhRegistrationHandler.transformInputToNhBaseRegistration(inputRegistration);

    if (!inputRegistration.deviceId) {
        throw new core.MobileServiceError('Creating or updating a Wns registration requires the body to contain a deviceId containing a channelUri', core.ErrorCodes.BadInput);
    }

    registration.ChannelUri = inputRegistration.deviceId;

    if (inputRegistration.templateBody) {
        registration._.ContentRootElement = 'WindowsTemplateRegistrationDescription';
        registration.BodyTemplate = inputRegistration.templateBody;
        if (inputRegistration.headers) {
            registration.WnsHeaders = {};
            registration.WnsHeaders.WnsHeader = _.map(inputRegistration.headers, function (value, headerName) { return { Header: headerName, Value: value }; });
        }

        if (inputRegistration.templateName) {
            registration.TemplateName = inputRegistration.templateName;
        } else {
            throw new core.MobileServiceError('Creating or updating a registration with a templateBody provided also requires a templateName as part of the body', core.ErrorCodes.BadInput);
        }
    } else {
        registration._.ContentRootElement = 'WindowsRegistrationDescription';
    }

    return registration;
};

// Provides the specific method to list registrations
WnsHandler.prototype.listRegistrations = function (deviceId, callback) {
    this.nhRegistrationHandler.notificationHubService.wns.listRegistrationsByChannel(deviceId, callback);
};

// Provides the specific property to snag the unique registration Id from
WnsHandler.prototype.getDeviceIdFromNhRegistration = function (regFromNh) {
    return regFromNh.ChannelUri;
};

// Converts any optional template members from Service Bus for this notifcation service into members of registration object
// for transfer to the client
WnsHandler.prototype.convertOptionalTemplatePropsToOutputRegistration = function (regFromNh, registration) {
    if (regFromNh.WnsHeaders) {
        if (regFromNh.WnsHeaders.WnsHeader) {
            registration.headers = {};
            // {"WnsHeader":[{"Header":"X-WNS-TTL","Value":"1"},{"Header":"X-WNS-Type","Value":"wns/toast"}]}
            _.each(regFromNh.WnsHeaders.WnsHeader, function (header) {
                registration.headers[header.Header] = header.Value;
            }, registration.headers);
        }
    }
};