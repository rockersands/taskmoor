# Backup XML parser spike: 0.05 GB

Generated 2026-10-12 10:10 UTC on AMD Ryzen 7 3700X 8-Core Processor (16 threads), Node v22.19.0.

Budget (M0-022): 5 GB in under 20 minutes with RSS under 512 MB. Result: 0.0 min at 32 MB/s, max RSS 239 MB.

| Measure | Value |
|---|---:|
| File | <repo>/.cache/xml/entities-50m.xml |
| Bytes | 50,038,203 |
| Entity rows | 280,434 |
| Generate time | 10.778s |
| Parse time | 1.551s |
| Throughput | 32 MB/s |
| Max RSS | 239 MB |
| NUL bytes removed | 11 |
| Other C0 controls removed | 9 |
| U+FFFE/U+FFFF removed | 4 |
| Invalid character references removed | 4 |

Every generated row and text character came out of the parser; every injected bad character was removed.
