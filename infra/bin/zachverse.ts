#!/usr/bin/env node
import { App } from 'aws-cdk-lib/core';
import { createStacks } from '../lib/app';
import { production } from '../lib/config';

createStacks(new App(), production);
