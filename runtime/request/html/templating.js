﻿// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Extremely trivial helper for inserting strings into text files and returning them as text/html
// We could switch to a proper template engine at some point if desired

exports = module.exports = {
    render: render
};

var fs = require('fs'),
    path = require('path'),
    StatusCodes = require('../../statuscodes').StatusCodes,
    templatesDir = path.resolve(__dirname, 'templates'),
    templatesCache = readAllTemplatesSync(templatesDir); // Load only once on app initialization

function render(responseCallback, templateName, data, responseHeaders) {
    if (!templatesCache.hasOwnProperty(templateName)) {
        throw new Error('Unknown template: ' + templateName);
    }

    var html = replaceTokens(templatesCache[templateName], data);
    responseHeaders = responseHeaders || {};
    responseHeaders['content-type'] = 'text/html';
    responseCallback(null, html, StatusCodes.OK, responseHeaders);
}

function replaceTokens(text, tokens) {
    // If we want to be more efficient, we might consider switching to a precompiled template engine.
    // This logic assumes that token names don't include regex-special chars.
    // It also assumes that tokens will only be inserted into JavaScript code, hence the JSON-serialization.
    // Do not use this to insert tokens into HTML markup, because the tokens will not be correctly encoded.
    // If our requirements get more sophisticated, we should switch to a proper template engine.
    if (typeof tokens === 'object') {
        for (var token in tokens) {
            if (tokens.hasOwnProperty(token)) {
                var value = tokens[token];
                text = text.replace(new RegExp('{{' + token + '}}', 'g'), JSON.stringify(value));
            }
        }
    }

    return text;
}

function readAllTemplatesSync(dir) {
    var files = fs.readdirSync(dir),
        htmlFiles = files.filter(function (filename) {
            return path.extname(filename) == '.html';
        }),
        result = {};

    htmlFiles.forEach(function (filename) {
        result[filename] = fs.readFileSync(path.resolve(dir, filename), 'utf8');
    });

    return result;
}