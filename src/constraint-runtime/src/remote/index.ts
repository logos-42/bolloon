import { loadArchiveMetadata } from '../_archive_helper.js';

const SNAPSHOT = loadArchiveMetadata('remote');

export const ARCHIVE_NAME = SNAPSHOT['archive_name'] as string;
export const MODULE_COUNT = SNAPSHOT['module_count'] as number;
export const SAMPLE_FILES = SNAPSHOT['sample_files'] as string[];
export const PORTING_NOTE = `Python placeholder package for '${ARCHIVE_NAME}' with ${MODULE_COUNT} archived module references.`;

export default {
  ARCHIVE_NAME,
  MODULE_COUNT,
  PORTING_NOTE,
  SAMPLE_FILES,
};
