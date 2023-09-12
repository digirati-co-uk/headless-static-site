import { pathToRegexp, compile } from 'path-to-regexp';
export interface SlugConfig {
  type: 'Manifest' | 'Collection';
  prefix: string;
  pattern: string;
  slugTemplate: string;
  parseOptions?: any;
  examples?: string[];
}

export type CompiledSlugConfig  = (url: string) => (readonly [string, Record<string, string>] | readonly [null, null]);

export function compileSlugConfig(config: SlugConfig): CompiledSlugConfig {
  const keys: any[] = [];
  const options: any = {};
  if (config.prefix.endsWith('/')) {
    config.prefix = config.prefix.slice(0, -1);
  }
  options.prefixes = [config.prefix];
  const pattern = pathToRegexp(config.pattern, keys, options);
  const slugTemplate = compile(config.slugTemplate);

  function getSlug(url: string) {
    const trimmed = config.prefix ? url.replace(config.prefix, '') : url;
    const result = pattern.exec(trimmed);
    if (!result) return [null, null] as const;
    const params: Record<string, string> = {};
    for (let i = 0; i < keys.length; i++) {
      params[keys[i].name] = result[i + 1];
    }
    return [slugTemplate(params), params] as const;
  }

  return getSlug;
}

export function compileReverseSlugConfig(config: SlugConfig): CompiledSlugConfig {
  const keys: any[] = [];
  const options: any = {};
  if (config.prefix.endsWith('/')) {
    config.prefix = config.prefix.slice(0, -1);
  }
  const pattern = pathToRegexp(config.slugTemplate, keys, options);
  const slugTemplate = compile(config.pattern);

  function getSlug(path: string) {
    if (path.startsWith('/') && !config.slugTemplate.startsWith('/')) {
      path = path.slice(1);
    } else if (!path.startsWith('/') && config.slugTemplate.startsWith('/')) {
      path = '/' + path;
    }

    const trimmed = config.prefix ? path.replace(config.prefix, '') : path;
    const result = pattern.exec(trimmed);
    if (!result) return [null, null] as const;
    const params: Record<string, string> = {};
    for (let i = 0; i < keys.length; i++) {
      params[keys[i].name] = result[i + 1];
    }
    let url = slugTemplate(params);
    if (!url.startsWith('/')) {
      url = '/' + url;
    }
    return [config.prefix + url, params] as const;
  }

  return getSlug;
}
