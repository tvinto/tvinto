# Models

The data types the app uses (streams, categories, guide programmes and so on)
live in `shared/types`, because the sync service and the CLI need them too.
`index.ts` re-exports them, so app code can import from here:

```typescript
import { Stream, Category, StreamType } from '../models';
```

The only type defined in this folder is `FormModel<T>` in `form.model.ts`. It
turns a plain object type into the matching set of typed form controls.
