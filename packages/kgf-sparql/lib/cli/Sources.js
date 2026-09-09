"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSource = parseSource;
exports.describeKgfSource = describeKgfSource;
/**
 * Parses a `kind@url` source argument: `kgf@` for a KGF fragment or dataset URL,
 * `sparql@` for a SPARQL endpoint named explicitly, or another Comunica source type.
 * A bare URL is refused: a tool that writes provenance should not guess what it queried.
 */
function parseSource(argument) {
    const match = /^([a-z][a-z0-9_-]*)@(.+)$/iu.exec(argument);
    if (!match) {
        throw new Error(`Source '${argument}' needs a kind prefix, such as kgf@<fragment-url> or sparql@<endpoint-url>`);
    }
    const [, kind, url] = match;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`Source '${argument}' is not an absolute URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Source '${argument}' must be an HTTP(S) URL`);
    }
    return { kind: kind.toLowerCase(), url };
}
/**
 * Describes a KGF source for the receipt from one request to its dataset descriptor,
 * pinning a `latest` alias or bare dataset URL to the release the engine will read.
 * Accepts every URL form the engine does: a versioned fragment or version URL, a dataset
 * URL, or its `/latest/fragment` alias.
 */
async function describeKgfSource(url, fetchFunction) {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/u, '');
    const versioned = /^(.*)\/v\/([^/]+)(?:\/fragment)?$/u.exec(path);
    const datasetPath = versioned ? versioned[1] : path.replace(/\/latest\/fragment$/u, '');
    const descriptorUrl = new URL(datasetPath, parsed).href;
    const response = await fetchFunction(descriptorUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Dataset descriptor ${descriptorUrl} answered ${response.status} ${response.statusText}`);
    }
    const descriptor = await response.json();
    const version = versioned ? versioned[2] : descriptor.current;
    const release = Array.isArray(descriptor.releases) ?
        descriptor.releases
            .find(entry => entry.version === version) :
        undefined;
    if (typeof release?.links?.fragment !== 'string') {
        throw new Error(`Dataset descriptor ${descriptorUrl} lists no release '${String(version)}' with a fragment link`);
    }
    return {
        kind: 'kgf',
        url: new URL(release.links.fragment, descriptorUrl).href,
        dataset: typeof descriptor.id === 'string' ? descriptor.id : datasetPath.slice(datasetPath.lastIndexOf('/') + 1),
        version: String(version),
        content_digest: typeof release.content_digest === 'string' ? release.content_digest : null,
    };
}
//# sourceMappingURL=Sources.js.map