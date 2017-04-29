
// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

var _ = require('underscore');

var _str = require('underscore.string');

_.mixin(_str.exports());

((exports => {

    function curry(fn) {
        var slice = Array.prototype.slice;
        var args = slice.call(arguments, 1);
        return function () {
            return fn(...args.concat(slice.call(arguments)));
        };
    }

    function extend(target, members) {
        for (var member in members) {
            target[member] = members[member];
        }
        return target;
    }

    function defineClass(ctor, instanceMembers, classMembers) {
        ctor = ctor || (() => { });
        if (instanceMembers) {
            extend(ctor.prototype, instanceMembers);
        }
        if (classMembers) {
            extend(ctor, classMembers);
        }
        return ctor;
    }

    function deriveClass(baseClass, ctor, instanceMembers) {
        var basePrototype = baseClass.prototype;
        var prototype = {};
        extend(prototype, basePrototype);

        var getPrototype = (name, fn) => function(...args) {
            var tmp = this._super;
            this._super = basePrototype;
            var ret = fn.apply(this, args);
            this._super = tmp;
            return ret;
        };

        if (instanceMembers) {
            for (var name in instanceMembers) {
                // Check if we're overwriting an existing function
                prototype[name] = typeof instanceMembers[name] === 'function' && typeof basePrototype[name] === 'function' ?
                    getPrototype(name, instanceMembers[name]) : instanceMembers[name];
            }
        }

        ctor = ctor ?
            ((fn => function(...args) {
                var tmp = this._super;
                this._super = basePrototype;
                var ret = fn.apply(this, args);
                this._super = tmp;
                return ret;
            }))(ctor)
            : () => { };

        ctor.prototype = prototype;
        ctor.prototype.constructor = ctor;
        return ctor;
    }

    function classof(o) {
        if (o === null) {
            return 'null';
        }
        if (o === undefined) {
            return 'undefined';
        }
        return Object.prototype.toString.call(o).slice(8, -1).toLowerCase();
    }

    function isArray(o) {
        return classof(o) === 'array';
    }

    function isObject(o) {
        return classof(o) === 'object';
    }

    function isDate(o) {
        return classof(o) === 'date';
    }

    function isFunction(o) {
        return classof(o) === 'function';
    }

    function isString(o) {
        return classof(o) === 'string';
    }

    function isNumber(o) {
        return classof(o) === 'number';
    }

    function isError(o) {
        return classof(o) === 'error';
    }

    function isGuid(value) {
        return isString(value) && /[a-fA-F\d]{8}-(?:[a-fA-F\d]{4}-){3}[a-fA-F\d]{12}/.test(value);
    }

    var hasProp = Object.prototype.hasOwnProperty;
    function isEmpty(obj) {
        if (obj === null || obj === undefined) {
            return true;
        }
        for (var key in obj) {
            if (hasProp.call(obj, key)) {
                return false;
            }
        }
        return true;
    }

    function sameArrayContents(array1, array2) {
        if (array1.length !== array2.length) {
            return false;
        } else {
            for (var i = 0; i < array1.length; i++) {
                if (array1[i] !== array2[i]) {
                    return false;
                }
            }
        }
        return true;
    }

    // This routine provides an equivalent of array.push(item) missing from JavaScript array.
    function arrayRemove(array, item) {
        var callback = isFunction(item) ? item : undefined;
        for (var index = 0; index < array.length; index++) {
            if (callback ? callback(array[index]) : (array[index] === item)) {
                array.splice(index, 1);
                return index;
            }
        }
        return -1;
    }

    function isLetter(ch) {
        if (ch >= 'A' && ch <= 'Z') {
            // uppercase letter
            return true;
        }

        if (ch >= 'a' && ch <= 'z') {
            // lowercase letter
            return true;
        }

        return false;
    }

    function isDigit(ch) {
        if (ch >= '0' && ch <= '9') {
            return true;
        }
        return false;
    }

    function isValidStringId(id) {
        return !stringIdValidatorRegex.test(id);
    }

    function verbToOperation(verb) {
        if (typeof verb !== 'string' || verb.length === 0) {
            throw new Error('Verb must be a non empty string');
        }
        switch (verb.toUpperCase()) {
            case 'POST':
                return 'insert';
            case 'GET':
                return 'read';
            case 'PATCH':
                return 'update';
            case 'DELETE':
                return 'delete';
            default:
                return null;
        }
    }

    function isSystemColumnName(name) {
        return _.startsWith(name, '__');
    }

    // determines whether the specified value is of a supported type
    function isOfSupportedType(value) {
        if (value === null) {
            return true;
        }
        switch (exports.classof(value)) {
            case 'string':
            case 'number':
            case 'boolean':
            case 'date':
                return true;
            default:
                return false;
        }
    }

    // verifies that the specified value is of a supported type, and throws an error otherwise
    function validatePropertyType(propertyName, value) {
        if (!isOfSupportedType(value)) {
            throw new MobileServiceError(_.sprintf("The value of property '%s' is of type '%s' which is not a supported type.", propertyName, (typeof value)), ErrorCodes.BadInput);
        }
    }

    // perform any required type conversions to members of the object and
    // validate that no system properties are present.
    function performTypeConversions(item, tableMetadata) {
        for (var prop in item) {
            var value = item[prop];
            // attempt to convert date strings to actual
            // Date values
            if (prop !== 'id' && isString(value)) {
                var date = convertDate(value);
                if (date) {
                    item[prop] = date;
                }
                else if (tableMetadata.hasBinaryColumn(prop)) {
                    item[prop] = new Buffer(value, 'base64');
                }
            }
        }
    }

    function convertDate(value) {
        var date = parseISODate(value);
        if (date) {
            return date;
        }

        date = parseMsDate(value);
        if (date) {
            return date;
        }

        return null;
    }

    // attempt to parse the value as an ISO 8601 date (e.g. 2012-05-03T00:06:00.638Z)
    function parseISODate(value) {
        if (iso8601Regex.test(value)) {
            return parseDateTimeOffset(value);
        }

        return null;
    }

    // parse a date and convert to UTC
    function parseDateTimeOffset(value) {
        var ms = Date.parse(value);
        if (!isNaN(ms)) {
            return new Date(ms);
        }
        return null;
    }

    // attempt to parse the value as an MS date (e.g. "\/Date(1336003790912-0700)\/")
    function parseMsDate(value) {
        var match = msDateRegex.exec(value);
        if (match) {
            // Get the ms and offset
            var milliseconds = parseInt(match[2], 10);
            var offsetMinutes = 0;
            if (match[5]) {
                var hours = parseInt(match[5], 10);
                var minutes = parseInt(match[6] || '0', 10);
                offsetMinutes = (hours * 60) + minutes;
            }

            // Handle negation
            if (match[1] === '-') {
                milliseconds = -milliseconds;
            }
            if (match[4] === '-') {
                offsetMinutes = -offsetMinutes;
            }

            var date = new Date();
            date.setTime(milliseconds + offsetMinutes * 60000);
            return date;
        }
        return null;
    }

    // Expected errors that are caught within the framework are
    // wrapped using a MobileServiceError to provide sanitized
    // error messages and stack traces to end-user code.
    var MobileServiceError = deriveClass(Error, function (value, code) {
        // If an Error object is passed in, set the innerError and sanitize the stack
        if (isError(value)) {
            this.message = value.message;
            this.innerError = value;
            this.stack = this.innerError.stack = exports.sanitizeUserCallStack(this.innerError);
        } else {
            // If this is a merge conflict, the first parameter will be the original item
            // involved in the update or delete
            Object.defineProperty(this, 'isMergeConflict', {
                get() {
                    return code === ErrorCodes.MergeConflict;
                }
            });
            Object.defineProperty(this, 'isConflict', {
                get() {
                    return code === ErrorCodes.Conflict;
                }
            });
            var hasItem = isObject(value);
            if ((this.isMergeConflict || this.isConflict) && hasItem) {                
                this.item = value;
            }

            // If anything other than an Error is passed in (maybe a string),
            // force node to get a stack trace and sanitize it
            this.message = hasItem ? stringify(value) : value.toString();
            Error.captureStackTrace(this, MobileServiceError);
            this.stack = exports.sanitizeUserCallStack(this);
        }

        // Only create a code property if the code parameter is present
        if (code) {
            this.code = code;
        }
    }, {
        toString() {
            if (this.innerError) {
                return this.innerError.toString(); // Preserve error type prefix (ie: SyntaxError:, SqlError:)
            } else {
                return Error.prototype.toString.call(this);
            }
        }
    });

    // Keep the existing error message prefix (ie: Error: Some bad error message)
    MobileServiceError.prototype.name = "Error";

    // Validates that the specified callback options object conforms to
    // the Zumo success/error/conflict form. SystemProperties can also be set.
    function validateCallbackOptions(callbackOptions, operation, options) {        
        if (!_validateCallbackOptions(callbackOptions, operation, options)) {
            var supportedOptions = (options && options.supportsConflict) ?
                                    "'success', 'error' or 'conflict'" :
                                    "'success' or 'error'";
            throw new Error(_.sprintf("Invalid callback options passed to '%s'. Callback options must be an object with at least one %s property of type 'function' or a systemProperties property of type 'Array'.", operation, supportedOptions));
        }
    }

    function _validateCallbackOptions(callbackOptions, operation, options) {
        if (callbackOptions === undefined) {
            return true;
        }

        // must be an object
        if (!exports.isObject(callbackOptions)) {
            return false;
        }

        // enumerate all properties and make sure they're valid
        var hasOption = false;
        for (var prop in callbackOptions) {
            switch (prop) {
                case 'success':
                case 'error':
                    if (!exports.isFunction(callbackOptions[prop])) {
                        return false;
                    }
                    hasOption = true;
                    break;
                case 'conflict':
                    if (!options ||
                        !options.supportsConflict ||
                        !exports.isFunction(callbackOptions[prop])) {
                        return false;
                    }
                    hasOption = true;
                    break;
                case 'systemProperties':
                    if (!exports.isArray(callbackOptions[prop])) {
                        return false;
                    }
                    hasOption = true;
                    break;
                case 'includeDeleted':
                    if (!options ||
                        !options.supportsIncludeDeleted ||
                        !_.isBoolean(callbackOptions[prop])) {
                        return false;
                    }
                    hasOption = true;
                    break;
                default:
                    return false;
            }
        }

        if (!hasOption) {
            // for a non-null callback option, at least one valid option
            // must be defined
            return false;
        }

        return true;
    }

    function isStarSystemProperty(systemProperties)
    {
        systemProperties = Array.isArray(systemProperties) ? systemProperties : [systemProperties];
        return systemProperties.length === 1 && isString(systemProperties[0]) && systemProperties[0].trim() === "*";
    }

    function getSystemProperty(name) {
        name = name.toLowerCase();
        return _.find(supportedSystemProperties, property => property.name.toLowerCase() === name);
    }

    function validateAndNormalizeSystemProperties(systemProperties) {
        if (!systemProperties) {
            return [];
        }

        var normalizedSystemProperties = [];

        // Ensure we have an array
        systemProperties = isArray(systemProperties) ? systemProperties : [systemProperties];

        // Check for the '*' (all system properties) value
        if (isStarSystemProperty(systemProperties)) {
            normalizedSystemProperties = supportedSystemProperties.map(property => property.name);
        }
        else {
            // otherwise, validate each individual system property
            _.each(systemProperties, systemProperty => {
                var original = systemProperty;
                var isKnownProperty = false;

                if (isString(systemProperty)) {
                    // remove any whitespace and make all lower case
                    systemProperty = systemProperty.trim();
                    if (systemProperty === '') {
                        return;
                    }

                    // accept both with and without the '__' prefix
                    if (isSystemColumnName(systemProperty)) {
                        systemProperty = systemProperty.substr(2);
                    }

                    var supportedSystemProperty = getSystemProperty(systemProperty);
                    if (supportedSystemProperty) {
                        normalizedSystemProperties.push(supportedSystemProperty.name);
                        isKnownProperty = true;
                    }
                }

                if (!isKnownProperty) {
                    throw new MobileServiceError(_.sprintf("The value '%s' is not a supported system property.", original), ErrorCodes.BadInput);
                }
            });
        }

        return normalizedSystemProperties;
    }

    function parseBoolean(bool) {
        if (bool === undefined || bool === null || typeof bool !== 'string') {
            return undefined;
        } else if (bool.toLowerCase() === 'true') {
            return true;
        } else if (bool.toLowerCase() === 'false') {
            return false;
        } else {
            return undefined;
        }
    }

    function getContentType(req) {
        var contentType = req.headers['content-type'] || '';
        return contentType.split(';')[0];
    }

    // For the specified error, determine from the stack trace whether the
    // error is from user script. If so, return a source string.
    function parseUserScriptError(e) {
        if (e && e.stack) {
            // search for a user script file pattern in each stack frame
            // a user stack frame line is of the form "at Object._onTimeout (</table/checkins.insert.js>:3:27)"
            // note that the '<>' delimiters we place on virtual user script filenames, ensures that
            // we never get a false match (since these aren't valid filename chars).
            var frames = e.stack.split('\n');
            for (var i = 1; i < frames.length; i++) {
                var match = _isUserScriptError(frames[i]);
                if (match) {
                    return match;
                }
            }
        }

        return null;
    }

    // if the current stack trace includes user script stack frames,
    // return a source string (e.g. /api/calculator.js)
    function getUserScriptSource() {
        return exports.parseUserScriptError(new Error());
    }

    function sanitizeUserCallStack(error) {
        // if a stack is present, we want to 'blank out' and compress
        // any 'external' framework stack frames
        var userCallStack = '';
        if (!error) {
            return userCallStack;
        }

        if (error.stack) {
            // split the stack into frames
            var frames = error.stack.split('\n');

            // go through all the frames, blanking out non user code frames, and compressing
            // runs of 'external code'
            var keepFrames = [];
            keepFrames.push(frames[0]);
            var inExternal = false;
            var hasInternal = false;
            for (var i = 1; i < frames.length; i++) {
                if (_isUserScriptError(frames[i])) {
                    // keep user stack frames
                    keepFrames.push(frames[i]);
                    inExternal = false;
                    hasInternal = true;
                }
                else {
                    if (!inExternal) {
                        keepFrames.push('    [external code]');
                        inExternal = true;
                    }
                }
            }

            if (hasInternal) {
                userCallStack = keepFrames.join('\n');
            } else {
                // If there are no user code frames, just take the first frame which contains the error
                userCallStack = keepFrames[0];
            }
        }
        else {
            return error.message || error.toString();
        }

        return userCallStack;
    }

    function _isUserScriptError(frame) {
        var match = userScriptRegexVM.exec(frame);
        if (match) {
            return _.sprintf('/%s/%s.js', match[1], match[2]);
        }

        match = userScriptRegex.exec(frame);
        if (match) {
            return _.sprintf('/%s/%s.js', match[1], match[2]);
        }

        return null;
    }    

    
    // Following paths in call stack do not point to file that caused the error.
    var ignorePaths = ['Microsoft.Azure.Zumo.Runtime.Node.Test'];
    function isIgnoredPathInFrame(frame) {
        var found = _.any(ignorePaths, path => frame.indexOf(path) > 0);
        return found;
    }

    function getTopFrame(stack) {
        var frames = stack.split('\n');
        var frameIndex = 1; // 0 frame has error description not call stack

        for (frameIndex = 1; frameIndex < frames.length; frameIndex++) {
            var frame = frames[frameIndex];
            if (!isIgnoredPathInFrame(frame)) {
                return frame;        
            }
        }

        return null;
    }

    // Determines whether given path caused the error e.g. //runtime//
    function isPathSourceOfError(e, path) {
        if (!e || !e.stack) {
            return false;
        }
        
        var topFrame = getTopFrame(e.stack);
        var found = (topFrame && topFrame.indexOf(path) > 0);
        return found;
    }

    function isRuntimeError(e) {
        // if the error is a MobileServiceError, it is an error intended
        // for the end user (e.g. bad input)
        if (e instanceof core.MobileServiceError) {
            return false;
        }

        var queryParsingError = isPathSourceOfError(e, 'Zumo.Node.js'); // we asume Zumo.Node.js errors are because of bad query created by user.
        var userError = queryParsingError || parseUserScriptError(e); // if user script is anywhere in the stack, we'll treat this as a user error.
        if (userError) {
            return false;
        }

        // we'll treat any call stack exceeded errors as user errors, since
        // that is the most likely case (based on historical log analysis)
        if (isMaxCallStackError(e)) {
            return false;
        }

        return isPathSourceOfError(e, '\\runtime\\');
    }

    function isMaxCallStackError(error) {
        return error && error.toString() == 'RangeError: Maximum call stack size exceeded';
    }

    // creates a lazy property on the target using the name and
    // value provider function specified.
    function createLazyProperty(target, name, valueProvider) {
        var value;

        Object.defineProperty(target, name, {
            get() {
                if (value === undefined) {
                    // if we haven't accessed the value yet, get it
                    // and cache it
                    value = valueProvider();
                }
                return value;
            }
        });
    }

    function parseNumber(numberText, identifier) {
        var number = parseInt(numberText, 10);
        if (isNaN(number) || (number != numberText)) {
            throw new exports.MobileServiceError(_.sprintf("The value specified for '%s' must be a number.", identifier), exports.ErrorCodes.BadInput);
        }
        return number;
    }

    // for the specified array of objects, plucks a key value from
    // each object in the array, and adds it as a property to the map.
    function toLookup(array, map, keySelector) {
        if (!Array.isArray(array)) {
            throw Error('First parameter must be an array');
        }
        array.forEach(item => {
            var key = keySelector(item);
            map[key] = item;
        });
    }

    // Any code paths that serialize the response body to JSON
    // should use this version of stringify to ensure that all 
    // byte arrays (Buffers in node.js) are serialized correctly.
    function stringify(itemToStringify) {
        return JSON.stringify(itemToStringify, (item, value) => {
            if (Buffer.isBuffer(value)) {
                value = value.toString('base64');
            }
            return value;
        });
    }

    var async = {
        // run the specified array of functions in sequence
        // series: array of functions
        // done: the callback to call after all have been run
        series(series, done) {
            var stepIdx = 0;

            var next = err => {
                if (err || stepIdx == (series.length)) {
                    done(err);
                }
                else {
                    series[stepIdx++](next);
                }
            };

            next();
        },

        // run the specified array of functions in parallel
        // series: array of functions
        // done: the callback to call after all have been run
        parallel(series, done) {
            var completed = 0;
            var complete = err => {
                if (err || ++completed == series.length) {
                    done(err);
                }
            };

            // start all functions in parallel
            series.forEach(f => {
                f(complete);
            });
        }
    };

    var ErrorCodes = {
        BadInput: "BadInput",
        ScriptError: "ScriptError",
        ItemNotFound: "ItemNotFound",
        MethodNotAllowed: "MethodNotAllowed",
        MergeConflict: "MergeConflict",
        ItemSoftDeleted: "ItemSoftDeleted",
        Conflict: "Conflict"
    };

    // The system properties that are supported
    var supportedSystemProperties = [
        { name: 'createdAt', type: 'datetimeoffset' },
        { name: 'updatedAt', type: 'datetimeoffset' },
        { name: 'version', type: 'timestamp' },
        { name: 'deleted', type: 'bit' }
    ];

    // Column names of supported system properties and id column
    var supportedSystemColumns = supportedSystemProperties.map(systemPropertyToColumnName);
    supportedSystemColumns.id = 'id';

    function systemPropertyToColumnName(propertyName) {
        return '__' + propertyName;
    }

    function base64UrlEncode(value) {
        return toUrlEncodedBase64FromBase64(new Buffer(value).toString('base64'));        
    }
    
    function toUrlEncodedBase64FromBase64(value) {
        return _.rtrim(value, '=')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    }

    function base64UrlDecode(encoded) {
        // use Buffer to decode
        var buf = new Buffer(toBase64FromUrlEncodedBase64(encoded), 'base64');
        return buf.toString();
    }

    function toBase64FromUrlEncodedBase64(base64UrlString) {
        var base64String = base64UrlString
        .replace(/\-/g, '+')
        .replace(/_/g, '/');
        return padBase64String(base64String);
    }

    function normalizeVersion(version) {
        var buffer = Buffer.isBuffer(version) ? version : new Buffer(version, 'base64');
        // if version is not 8 bytes, its not sql server rowversion
        if (buffer.length !== 8 ||
            // if version is not valid base64 string
            (_.isString(version) && buffer.toString('base64') !== version)) {
            // reset version to 0000
            version = '0A=';
        }
        return version;
    }

    function padBase64String(encoded) {
        // Pad with trailing '='s
        switch (encoded.length % 4) {
            case 0:
                return encoded; // No pad chars in this case
            case 2:
                encoded += "==";
                return encoded; // Two pad chars
            case 3:
                encoded += "=";
                return encoded; // One pad char
            default:
                throw new Error("The authentication token contains illegal base64 url string.");
        }
    }

    function ensureParamNotNull(value, name) {
        if (!value) {
            throw new Error(_.sprintf("Parameter '%s' cannot be null or undefined.", name));
        }
	}

    // TEMP: This is only necessary during the migration to site extensions. 
    // Once migration is complete, the 'scripts' format will no longer be supported and this function can be removed.
    function getScriptsDirName(configPath) {
        return _str.endsWith(configPath, 'config') ? 'scripts' : 'service';            
    }

    // parse a comma separated csv setting into an array
    // e.g. "a,b,c" => ["a", "b", "c"]
    function parseCsvSetting(setting) {
        var arr = [];

        if (setting && setting.length > 0) {
            // if the setting is set to a non-empty string,
            // parse into an array
            arr = _.words(setting, ',');
        }

        return arr;
    }

    // pre-defined routines
    exports.parseCsvSetting = parseCsvSetting;
    exports.ensureParamNotNull = ensureParamNotNull;
    exports.MAX_INT = 9007199254740992;
    exports.getSystemProperty = getSystemProperty;
    exports.supportedSystemProperties = supportedSystemProperties;
    exports.supportedSystemColumns = supportedSystemColumns;
    exports.defineClass = defineClass;
    exports.deriveClass = deriveClass;
    exports.classof = classof;
    exports.isArray = isArray;
    exports.isObject = isObject;
    exports.isDate = isDate;
    exports.isFunction = isFunction;
    exports.isGuid = isGuid;
    exports.isString = isString;
    exports.isNumber = isNumber;
    exports.isError = isError;
    exports.isValidStringId = isValidStringId;
    exports.stringify = stringify;
    exports.sameArrayContents = sameArrayContents;
    exports.arrayRemove = arrayRemove;
    exports.isLetter = isLetter;
    exports.isDigit = isDigit;
    exports.extend = extend;
    exports.verbToOperation = verbToOperation;
    exports.isSystemColumnName = isSystemColumnName;
    exports.isOfSupportedType = isOfSupportedType;
    exports.validatePropertyType = validatePropertyType;
    exports.curry = curry;
    exports.parseDateTimeOffset = parseDateTimeOffset;
    exports.parseISODate = parseISODate;
    exports.performTypeConversions = performTypeConversions;
    exports.MobileServiceError = MobileServiceError;
    exports.validateCallbackOptions = validateCallbackOptions;
    exports.isStarSystemProperty = isStarSystemProperty;
    exports.validateAndNormalizeSystemProperties = validateAndNormalizeSystemProperties;
    exports.parseBoolean = parseBoolean;
    exports.ErrorCodes = ErrorCodes;
    exports.parseUserScriptError = parseUserScriptError;
    exports.sanitizeUserCallStack = sanitizeUserCallStack;
    exports.isRuntimeError = isRuntimeError;
    exports.async = async;
    exports.createLazyProperty = createLazyProperty;
    exports.parseNumber = parseNumber;
    exports.getUserScriptSource = getUserScriptSource;
    exports.toLookup = toLookup;
    exports.getContentType = getContentType;
    exports.systemPropertyToColumnName = systemPropertyToColumnName;
    exports.base64UrlEncode = base64UrlEncode;
    exports.base64UrlDecode = base64UrlDecode;
    exports.toBase64FromUrlEncodedBase64 = toBase64FromUrlEncodedBase64;
    exports.toUrlEncodedBase64FromBase64 = toUrlEncodedBase64FromBase64;
    exports.normalizeVersion = normalizeVersion;
    exports.getScriptsDirName = getScriptsDirName;

    // Match YYYY-MM-DDTHH:MM:SS.sssZ, with the millisecond (.sss) part optional
    // Note: we only support a subset of ISO 8601
    var iso8601Regex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})\:(\d{2})\:(\d{2})(\.(\d{3}))?Z$/;

    // Match MS Date format "\/Date(1336003790912-0700)\/"
    var msDateRegex = /^\/Date\((-?)(\d+)(([+\-])(\d{2})(\d{2})?)?\)\/$/;

    // Regex used to parse user script filename components from stack traces.
    // This will match on any javascript file in the form of <type/filename.js>,
    // which is the virtual file format we use when running script in the VM context.
    // I.e. it will identify and parse (</table/checkins.insert.js>:3:27) as well as (</shared/apnsfeedback.js>:2:10).
    var userScriptRegexVM = /^.*\(?<\/(\w+)\/([\w\.]+)\.js>\:\d+\:\d+\)?$/i;

    // Regex used to parse user script filename components from stack traces
    // NOT originating from the VM context.
    var userScriptRegex = /^.*\(?.*(?:config\\scripts|service)\\(\w+)\\(\w+).js\:\d+\:\d+\)?$/i;

    // Regex to validate string ids to ensure that it does not include any characters which can be used
    // within a URI
    var stringIdValidatorRegex = /([\u0000-\u001F]|[\u007F-\u009F]|["\+\?\\\/\`]|^\.{1,2}$)/;


}))(typeof exports === 'undefined' ? (this.core = {}) : exports);
