// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for handling table requests end to end (query/insert/update/delete).

var DataPipeline = require('./datapipeline'),
    core = require('../core'),
    StatusCodes = require('../statuscodes').StatusCodes,
    resource = require('../resources'),
    ETagHelper = require('./etaghelper'),
    _ = require('underscore'),
    _str = require('underscore.string');

 _.mixin(_str.exports());

exports = module.exports = TableHandler;

var logSource = 'TableHandler';

function TableHandler(storage, scriptManager, metrics) {
    this.storage = storage;
    this.scriptManager = scriptManager;
    this.metrics = metrics;
}

TableHandler.prototype.handle = function (req, res) {
    var logger = req._context.logger,
        responseCallback = req._context.responseCallback,
        request = req._context.parsedRequest,
        self = this;

    request.table = req.params.table;
    request.id = req.params.id;
    request.body = req.body;
    request.user = req.user;

    logger.trace(logSource, 'Processing request');

    var dataPipeline = this._createDataPipeline(request, logger);

    this.storage.getTableMetadata(request.table, logger, function (err, tableMetadata) {

        if (err) {
            responseCallback(err);
            return;
        }

        if (!isIdValid(request, tableMetadata, responseCallback)) {
            return;
        }

        switch (request.verb) {
            case 'POST':
                if (request.id) {
                    self._handleUndelete(request, tableMetadata, dataPipeline, responseCallback);
                }
                else {
                    self._handleInsert(request, tableMetadata, dataPipeline, responseCallback);
                }
                break;
            case 'GET':
                self._handleRead(request, dataPipeline, responseCallback);
                break;
            case 'PATCH':
                self._handleUpdate(request, tableMetadata, dataPipeline, responseCallback);
                break;
            case 'DELETE':
                self._handleDelete(request, tableMetadata, dataPipeline, responseCallback);
                break;
        }
    });
};

TableHandler.prototype._handleRead = function (request, dataPipeline, responseCallback) {
    if (request.id !== undefined) {
        request.query.id = request.id;
    }

    dataPipeline.read(request.query, responseCallback);
};

TableHandler.prototype._handleUndelete = function (request, tableMetadata, dataPipeline, responseCallback) {
    if (!tableMetadata.supportsSoftDelete) {
        responseCallback(new core.MobileServiceError(resource.undeleteNotSupported, core.ErrorCodes.BadInput));
        return;
    }

    if (core.isObject(request.body)) {
        responseCallback(new core.MobileServiceError(resource.undeleteWithBodyNotAllowed, core.ErrorCodes.BadInput));
        return;
    }

    if (!isIdFieldValid(request, responseCallback)) {
        return;
    }

    dataPipeline.systemParameters.undelete = true;

    var item = request.body = { id: request.id, __deleted: false };
    if (!ETagHelper.setVersionFromIfMatchHeader(request, item, tableMetadata, responseCallback)) {
        return;
    }

    dataPipeline.update(item, responseCallback);   
};

TableHandler.prototype._handleInsert = function (request, tableMetadata, dataPipeline, responseCallback) {
    if (request.id !== undefined) {
        responseCallback(new core.MobileServiceError(resource.idInUrlNotAllowedOnInsert, core.ErrorCodes.BadInput));
        return;
    }

    if (!core.isObject(request.body)) {
        responseCallback(new core.MobileServiceError(resource.validJsonObjectExpected, core.ErrorCodes.BadInput));
        return;
    }

    if (!isIdFieldValid(request, responseCallback)) {
        return;
    }

    try {
        validateAndNormalizeItem(request.body, tableMetadata);
    }
    catch (error) {
        responseCallback(error);
        return;
    }

    responseCallback = _.wrap(responseCallback, function (oldCallback, error, result, statusCode) {
        var additionalHeaders = null;
        if (!error && request.body && request.body.id) {
            // if the insert was successful, add the Location header
            var path = request.url.split('?')[0]; // Remove the query parameters
            additionalHeaders = { 'Location': encodeURI(_.sprintf("https://%s%s/%s", request.headers.host, path, request.body.id)) };
        }
        oldCallback(error, result, statusCode, additionalHeaders);
    });

    dataPipeline.insert(request.body, responseCallback);
};

TableHandler.prototype._handleUpdate = function (request, tableMetadata, dataPipeline, responseCallback) {
    if (!request.id) {
        responseCallback(new core.MobileServiceError(resource.idValueRequiredOnUpdate, core.ErrorCodes.BadInput));
        return;
    }

    var item = request.body;
    if (!core.isObject(item)) {
        responseCallback(new core.MobileServiceError(resource.validJsonObjectExpected, core.ErrorCodes.BadInput));
        return;
    }

    if (!isIdFieldValid(request, responseCallback)) {
        return;
    }

    if (item.id !== undefined && item.id != request.id) {
        responseCallback(new core.MobileServiceError(resource.idInBodyDoesNotMatchUrl, core.ErrorCodes.BadInput));
        return;
    }

    try {
        validateAndNormalizeItem(item, tableMetadata);
    }
    catch (error) {
        responseCallback(error);
        return;
    }

    if (!ETagHelper.setVersionFromIfMatchHeader(request, item, tableMetadata, responseCallback)) {
        return;
    }

    item.id = request.id;
    dataPipeline.update(item, responseCallback);
};

TableHandler.prototype._handleDelete = function (request, tableMetadata, dataPipeline, responseCallback) {
    if (!request.id) {
        responseCallback(new core.MobileServiceError(resource.idValueRequiredOnDelete, core.ErrorCodes.BadInput));
        return;
    }

    var item = { id: request.id };

    if (!ETagHelper.setVersionFromIfMatchHeader(request, item, tableMetadata, responseCallback)) {
        return;
    }

    dataPipeline.del(item, responseCallback);
};

TableHandler.prototype._createDataPipeline = function (request, logger) {
    return new DataPipeline(this.storage, this.scriptManager, request, request.user, logger, this.metrics);
};

function validateAndNormalizeItem(item, tableMetadata) {
    core.performTypeConversions(item, tableMetadata);

    if (tableMetadata.hasStringId) {        
        var systemColumnName = _.find(Object.keys(item), core.isSystemColumnName);
        if (systemColumnName) {
            throw new core.MobileServiceError(_.sprintf("The property '%s' can not be set. Properties that begin with a '__' are considered system properties.", systemColumnName), core.ErrorCodes.BadInput);
        }
    }
}

function isIdValid(request, tableMetadata, responseCallback) {
    if (tableMetadata.hasStringId) {
        return isStringIdValid(request, responseCallback);
    }
    
    return isIntIdValid(request, responseCallback);
}

function isIntIdValid(request, responseCallback) {
    if (request.id === undefined) {
        return true;
    }

    try {
        request.id = core.parseNumber(request.id, 'id');
    }
    catch (e) {
        responseCallback(e, null, StatusCodes.BAD_REQUEST);
        return false;
    }
    return true;
}

function isStringIdValid(request, responseCallback) {
    if (request.id !== undefined && !core.isValidStringId(request.id)) {
        responseCallback(new core.MobileServiceError(resource.stringIdNotValid, core.ErrorCodes.BadInput));
        return false;
    }

    if (!request.body ||
        request.body.id === null ||
        request.body.id === undefined) {
        return true;
    }
    
    if (!core.isString(request.body.id)) {
        responseCallback(new core.MobileServiceError(resource.idMustBeAString, core.ErrorCodes.BadInput));
        return false;
    }
    if (!core.isValidStringId(request.body.id)) {
        responseCallback(new core.MobileServiceError(resource.stringIdNotValid, core.ErrorCodes.BadInput));
        return false;
    }

    return true;
}

function isIdFieldValid(request, responseCallback) {
    // If an object has any id casing other than 'id', return an error.
    if (['ID', 'Id', 'iD'].some(function (idFormat) {
        return request.body.hasOwnProperty(idFormat);
    })) {
        responseCallback(new core.MobileServiceError(resource.idPropertyCaseMismatch, core.ErrorCodes.BadInput));
        return false;
    }
    return true;
}
