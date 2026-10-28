The failing query:

```sql
SELECT id, key
  FROM ticket
 WHERE deleted_at IS NULL;
```
