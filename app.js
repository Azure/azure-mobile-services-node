// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// The Zumo runtime. Creates an instance of a Zumo server with options determined
// by env variables and starts listening on the port designated by the PORT env
// variable.
var Server = require('./runtime/server');

var server = new Server(process.env);
server.listen(process.env.PORT);