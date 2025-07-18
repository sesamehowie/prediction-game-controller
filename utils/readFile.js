import fs from 'fs';

export function readJson(filepath) {
    return JSON.parse(fs.readFileSync(filepath));
}