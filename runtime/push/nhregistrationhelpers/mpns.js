// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the helper to assist nhregistrationhandler with Mpns registration operations

var core = require('../../core'),
    _ = require('underscore');

exports = module.exports = MpnsHandler;

function MpnsHandler(nhRegistrationHandler) {
    this.nhRegistrationHandler = nhRegistrationHandler;
}

// Transform a javascript object fed to nhRegistrationHandler to an ordered, case sensitive javascript object ready for notificationHubService
// Format of result object:
// {
//   RegistrationId: '', --REQUIRED
//   Tags: 'tag1,tag2', --OPTIONAL
//   ChannelUri: '', --REQUIRED
//   BodyTemplate: '', --OPTIONAL--this controls whether this is a template
//   MpnsHeaders: '', --OPTIONAL--additional HTTP headers that NH will pass to Mpns when it sends the templated notifcation
//   TemplateName: '', --OPTIONAL (REQUIRED if BodyTemplate is provided)
//   _: --REQUIRED/UNORDERED--property bag with many optional properties, but only one is set here
//   _.ContentRootElement: --REQUIRED/UNORDERED-controls the type of the SOAP object eventually sent to notification hub
// }
MpnsHandler.prototype.transformInputToNhRegistration = function (inputRegistration) {
    var registration = this.nhRegistrationHandler.transformInputToNhBaseRegistration(inputRegistration);

    if (!inputRegistration.deviceId) {
        throw new core.MobileServiceError('Creating or updating an Mpns registration requires the body to contain a deviceId containing a channelUri', core.ErrorCodes.BadInput);
    }

    registration.ChannelUri = inputRegistration.deviceId;

    if (inputRegistration.templateBody) {
        registration._.ContentRootElement = 'MpnsTemplateRegistrationDescription';
        registration.BodyTemplate = inputRegistration.templateBody;
        if (inputRegistration.headers) {
            registration.MpnsHeaders = {};
            registration.MpnsHeaders.MpnsHeader = _.map(inputRegistration.headers, function (value, headerName) { return { Header: headerName, Value: value }; });
        }

        if (inputRegistration.templateName) {
            registration.TemplateName = inputRegistration.templateName;
        } else {
            throw new core.MobileServiceError('Creating or updating a registration with a templateBody provided also requires a templateName as part of the body', core.ErrorCodes.BadInput);
        }
    } else {
        registration._.ContentRootElement = 'MpnsRegistrationDescription';
    }

    return registration;
};

// Provides the specific method to list registrations
MpnsHandler.prototype.listRegistrations = function (deviceId, callback) {
    this.nhRegistrationHandler.notificationHubService.mpns.listRegistrationsByChannel(deviceId, callback);
};

// Provides the specific property to snag the unique registration Id from
MpnsHandler.prototype.getDeviceIdFromNhRegistration = function (regFromNh) {
    return regFromNh.ChannelUri;
};

// Converts any optional template members from Service Bus for this notifcation service into members of registration object
// for transfer to the client
MpnsHandler.prototype.convertOptionalTemplatePropsToOutputRegistration = function (regFromNh, registration) {
    if (regFromNh.MpnsHeaders) {
        if (regFromNh.MpnsHeaders.MpnsHeader) {
            registration.headers = {};
            _.each(regFromNh.MpnsHeaders.MpnsHeader, function (header) {
                registration.headers[header.Header] = header.Value;
            }, registration.headers);
        }
    }
};