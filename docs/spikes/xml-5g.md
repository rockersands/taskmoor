# Backup XML parser spike: 5.00 GB

Generated 2026-10-12 10:33 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), Node v22.19.0.

Budget (M0-022): 5 GB in under 20 minutes with RSS under 512 MB. Result: 2.5 min at 33 MB/s, max RSS 284 MB.

| Measure | Value |
|---|---:|
| File | <temp>/tracksmith-xml/entities-5g.xml |
| Bytes | 5,000,011,001 |
| Entity rows | 27,420,332 |
| Generate time | 0.001s |
| Parse time | 150.296s |
| Throughput | 33 MB/s |
| Max RSS | 284 MB |
| NUL bytes removed | 1078 |
| Other C0 controls removed | 810 |
| U+FFFE/U+FFFF removed | 257 |
| Invalid character references removed | 551 |

Every generated row and text character came out of the parser; every injected bad character was removed.
