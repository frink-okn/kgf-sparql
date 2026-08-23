#!/usr/bin/env node
const { runArgsInProcessStatic } = require('@comunica/runner-cli');
runArgsInProcessStatic(require('../engine-default.js')());
