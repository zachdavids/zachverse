#!/usr/bin/env node
import { App } from 'aws-cdk-lib/core';
import { createStacks } from '../lib/app';
import { production } from '../lib/config';

const { site } = createStacks(new App(), production);
if (!site) {
  console.error('ZachverseSite skipped: set certificateArn in infra/lib/config.ts first (docs/adr/0002).');
}
