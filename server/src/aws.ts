import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { config } from './config.js';

// Uses the default credential chain (AWS_PROFILE, env vars, SSO...).
export const rekognition = new RekognitionClient({ region: config.region });
