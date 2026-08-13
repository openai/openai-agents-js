import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

export const WeatherParameters = toStandardJsonSchema(
  v.object({
    city: v.pipe(v.string(), v.minLength(1)),
    unit: v.optional(v.picklist(['celsius', 'fahrenheit']), 'celsius'),
  }),
);

export const WeatherReport = toStandardJsonSchema(
  v.object({
    city: v.string(),
    temperature: v.number(),
    unit: v.picklist(['celsius', 'fahrenheit']),
  }),
);
