#!/usr/bin/env node
import { App } from 'aws-cdk-lib/core';
import { FAIL_SYNTH_ON_VALIDATION_ERRORS_CONTEXT } from 'aws-cdk-lib/cx-api';
import { createStacks } from '../lib/app';
import { production } from '../lib/config';

// The production stacks, which the guardrails check in every synthesis (lib/app.ts). The CLI tells every app not to
// fail on validation errors and fails on the recorded report itself, unless --ignore-errors (or CDK_IGNORE_ERRORS) is
// set. postCliContext outranks the CLI's context and cdk.json's, so the app fails on its own instead.
createStacks(new App({ postCliContext: { [FAIL_SYNTH_ON_VALIDATION_ERRORS_CONTEXT]: true } }), production);
