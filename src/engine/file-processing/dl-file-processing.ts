import crypto from "crypto";
import fs from "fs";
import DBFile from "../database/entities/db-file";
import * as mimetype from "mime-types";
import DBSetting from "../database/entities/db-setting";
import path from "path";
import {getAbsoluteDL} from "../core/paths";
import {dhash} from './image-dhash';
import {mutex} from "../util/promise-pool";
import DBSymLink from "../database/entities/db-symlink";
import {Brackets} from "typeorm";


export async function distHash(file: string): Promise<string|null> {
    return dhash(file, 8).then(async (res: Buffer) => {
        return res.toString('hex');
    }).catch(() => null);
}


function checksumFile(path: string, hashName = 'sha256'): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(hashName);
        const stream = fs.createReadStream(path);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}


export function hammingDist(str1: string, str2: string) {
    let diff = 0;
    for (let idx = 0; idx < str1.length; idx ++) {
        if (str1[idx] !== str2[idx]) diff++;
    }
    return diff;
}


/**
 * Creates & Saves a DBFile for the given path.
 *
 * Uses hashing to deduplicate files.
 * If a pre-existing match is found, deletes the worst file and returns the updated File with the new best path.
 *
 * This function is fully async, but is wrapped in a mutex so no more than one file may be deduplicated at a time.
 */
export const buildDedupedFile = mutex(async (fullPath: string, subpath: string, isAlbumFile: boolean) => {
    const stats = await fs.promises.stat(fullPath);
    if (!stats.isFile()) throw Error(`The given file output path does not exist: "${fullPath}"`);

    const checksum = await checksumFile(fullPath);
    const dh = await distHash(fullPath);
    const dChunks = dh?.match(/.{1,4}/g) || [];
    const skipAlbums = await DBSetting.get('skipAlbumFiles');

    if (await DBSetting.get('dedupeFiles') && !(isAlbumFile && skipAlbums)) {
        let closeMatches = await DBFile.createQueryBuilder('f')
            .select()
            .where(new Brackets(qb => {
                qb.where({shaHash: checksum})
                .orWhere('(:hash1 is not null and f.hash1 = :hash1)', {hash1: dChunks[0]})
                .orWhere('(:hash2 is not null and f.hash2 = :hash2)', {hash2: dChunks[1]})
                .orWhere('(:hash3 is not null and f.hash3 = :hash3)', {hash3: dChunks[2]})
                .orWhere('(:hash4 is not null and f.hash4 = :hash4)', {hash4: dChunks[3]})
            }))
            .andWhere('(not :skip or not f.isAlbumFile )', {skip: skipAlbums ? 1 : 0})
            .getMany();
        const similarity = await DBSetting.get('minimumSimiliarity');
        const match = closeMatches.find(m =>
            checksum === m.shaHash ||
            (similarity && m.dHash && dh && hammingDist(m.dHash || '', dh || '') < similarity)
        );

        if (match) {
            let best, worst;
            if (match.size < stats.size) {
                best = subpath;
                worst = match.path
            } else {
                best = match.path
                worst = subpath;
            }

            match.path = best;
            await match.save();
            await fs.promises.unlink(getAbsoluteDL(worst));

            if (await DBSetting.get('createSymLinks')) {
                await redirectSymLinks(worst, best);
                await fs.promises.symlink(path.resolve(getAbsoluteDL(best)), getAbsoluteDL(worst));
                await DBSymLink.build({
                    location: worst,
                    target: best
                }).save();
            }

            return match;
        }
    }

    return DBFile.build({
        shaHash: checksum,
        dHash: dh || null,
        hash1: dChunks[0] || null,
        hash2: dChunks[1] || null,
        hash3: dChunks[2] || null,
        hash4: dChunks[3] || null,
        mimeType: mimetype.lookup(fullPath) || '',
        path: subpath,
        size: stats.size,
        isDir: false,
        isAlbumFile
    }).save();
});

/**
 * Update all system links that currently point to the original location, and point them at the new location.
 * @param originalDest
 * @param newDest
 */
export async function redirectSymLinks(originalDest: string, newDest: string) {
    const links = await DBSymLink.find({target: originalDest});
    const target = getAbsoluteDL(newDest);

    for (const l of links) {
        const abs = getAbsoluteDL(l.location);
        const exists = await fs.promises.access(abs).then(()=>true).catch(()=>false);  // errors if file doesn't exist.

        if (exists) await fs.promises.unlink(abs);

        await fs.promises.symlink(target, abs);
        l.target = newDest;
        await l.save();
    }
}