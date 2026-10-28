## Summary

Saving a filter with a **long name** fails for [@Ana Ruiz](mention:12).

## Steps

1. Open _Filters_
2. Type 300 characters
3. Save

## Expected

The filter is saved or the form says the name is too long.

## Actual

```text
Error 500: value too long for type character varying(255)
```

> [!WARNING]
>
> Data is lost when the page reloads.

| Environment | Seen |
| ----------- | ---- |
| staging     | yes  |
| production  | no   |

- [ ] Add a length check
- [ ] Add a test

***

Logs: [build 2041](https://example.test/builds/2041)
