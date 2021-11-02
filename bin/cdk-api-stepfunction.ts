#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { CdkApiStepfunctionStack } from '../lib/cdk-api-stepfunction-stack';

const app = new cdk.App();
new CdkApiStepfunctionStack(app, 'ApiStepfunctionStack');
