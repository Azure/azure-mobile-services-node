// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

((exports => {

    // storage messages
    exports.colNotInSchema = "Could not save item because it contains a column that is not in the table schema.";
    exports.maxColSizeExceeded = "Could not save item because it exceeds a maximum column size restriction. Note that indexed columns are restricted to 450 characters.";
    exports.invalidIdentifier = "'%s' is not a valid identifier. Identifiers must be under 128 characters in length, start with a letter or underscore, and can contain only alpha-numeric and underscore characters.";
    exports.badRequest = "Bad request.";
    exports.itemWithIdAlreadyExists = "Could not insert the item because an item with that id already exists.";

    // server messages
    exports.maxBodySizeExceeded = "Request body maximum size limit was exceeded.";
    exports.validJsonObjectExpected = "A single (valid) JSON object is expected.";
    exports.undeleteWithBodyNotAllowed = "An undelete request must not have content.";
    exports.tripwireError =
        "One of your scripts caused the service to become unresponsive and the service was restarted. " +
        "This is commonly caused by a script executing an infinite loop or a long, blocking operation. " +
        "The service was restarted after the script continuously executed for longer than %d milliseconds.";

    // login handler errors
    exports.packageSidConfigurationMessage = 'Ensure that the Package SID has been correctly configured in the Windows Azure Mobile Service.';
    exports.packageSidMissing = 'Logging in with Windows 8 single sign-on is not enabled. ' + exports.packageSidConfigurationMessage;
    exports.ssoRedirectMismatchError = 'The redirect URI for Windows 8 single sign-on does not match the registered Package SID. ' + exports.packageSidConfigurationMessage;
    exports.googleApiKeyMissing = 'Unable to send notification: The Google API key is missing.';
    exports.apnsCertificateError = 'Socket hang up. This problem can be caused by an incorrect or invalid APNS certificate. Please try uploading your certificate again.';
    exports.apnsCertificateMissing = 'Unable to %s: the APNS certificate is not present.';
    exports.apnsInitializationFailed = 'Unable to load APNS module: %s';

    // table handler errors
    exports.idInUrlNotAllowedOnInsert = 'An id cannot be specified in the url for an insert operation.';
    exports.idMustBeAString = "The value specified for property 'id' must be a string";
    exports.undeleteNotSupported = "The undelete operation is not supported on this table.";
    exports.stringIdNotValid = "The value specified for property 'id' is invalid. An id must not contain any control characters or the characters \",+,?,\\,`.";
    exports.intIdValueNotAllowedOnInsert = "A value cannot be specified for property 'id'";
    exports.idValueRequiredOnUpdate = 'An id value must be specified in the URL for an update operation.';
    exports.idInBodyDoesNotMatchUrl = "When specified in the body, 'id' must match the id specified in the url.";
    exports.invalidIfMatchHeader = "Invalid 'if-match' header.";
    exports.onlySingleIfMatchHeaderSupported = "Only single etag 'if-match' headers are supported.";
    exports.idValueRequiredOnDelete = 'An id value must be specified in the URL for a delete operation.';
    exports.idPropertyCaseMismatch = "Item identifiers can only be specified via the 'id' property.";

    // misc errors
    exports.responseAlreadySent = 'Unable to write to the response - it has already been written. Ensure that for a given code path in your script, the response is only written to once (e.g. by using the execute/respond methods of the request object).';
    exports.newRelicError = 'A New Relic license key was found but the module could not be loaded. For more information on how to enable New Relic see http://go.microsoft.com/fwlink/?LinkID=327542';
    exports.itemNotFound = "An item with id '%s' does not exist.";
    
}))(typeof exports === 'undefined' ? (this.resource = {}) : exports);
