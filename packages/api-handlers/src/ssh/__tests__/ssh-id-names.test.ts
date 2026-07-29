/**
 * The SFTP pane could not show `root` / `www-data` because the protocol carries
 * only NUMERIC uid/gid in a listing. Names come from the server's passwd/group
 * databases, parsed here. Failure must degrade to "show the number", never
 * break a listing.
 */
import { describe, expect, it } from 'vitest';
import { __parseIdMapForTest as parseIdMap } from '../ssh-id-names.js';

describe('passwd/group parsing', () => {
  it('maps id → name from passwd lines', () => {
    const passwd = ['root:x:0:0:root:/root:/bin/bash', 'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin', 'deploy:x:1000:1000::/home/deploy:/bin/sh'].join('\n');
    expect(parseIdMap(passwd)).toEqual({ '0': 'root', '33': 'www-data', '1000': 'deploy' });
  });

  it('maps id → name from group lines (same shape)', () => {
    const group = ['root:x:0:', 'www-data:x:33:', 'docker:x:998:deploy'].join('\n');
    expect(parseIdMap(group)).toEqual({ '0': 'root', '33': 'www-data', '998': 'docker' });
  });

  it('keeps the FIRST name for a duplicated id (aliases must not flip it)', () => {
    // `toor` is a classic root alias; the pane should keep saying "root".
    expect(parseIdMap('root:x:0:0::/root:/bin/sh\ntoor:x:0:0::/root:/bin/sh')).toEqual({ '0': 'root' });
  });

  it('ignores blank lines, comments and malformed rows', () => {
    const raw = ['', '# a comment', 'broken', 'nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin', 'bad:x:notanumber:1'].join('\n');
    expect(parseIdMap(raw)).toEqual({ '65534': 'nobody' });
  });

  it('tolerates CRLF-ish junk and empty input', () => {
    expect(parseIdMap('')).toEqual({});
    expect(parseIdMap('\n\n')).toEqual({});
  });
});
