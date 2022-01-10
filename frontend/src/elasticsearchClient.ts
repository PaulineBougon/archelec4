import { omit, omitBy, isUndefined, isEmpty, toPairs, identity } from "lodash";
import {
  isWildcardSpecialValue,
  valueFromWildcardSpecialValue,
  wildcardSpecialValue,
} from "./components/filters/utils";
import { config } from "./config";
import {
  ESSearchQueryContext,
  FiltersState,
  FilterState,
  PlainObject,
  SearchResult,
  TermsFilterState,
  TermsFilterType,
} from "./types";
import { QueryDslQueryContainer, SearchRequest } from "@elastic/elasticsearch/api/types";

function getESQueryFromFilter(field: string, filter: FilterState): QueryDslQueryContainer {
  let query: QueryDslQueryContainer | null = null;

  //todo: move the spec retrieval in filterSatet build stage
  const filterSpec = filter.spec;

  switch (filter.type) {
    case "terms":
      query = {
        bool: {
          should: filter.value.map(
            (v): QueryDslQueryContainer => {
              if (isWildcardSpecialValue(v))
                // special value prefixed with WILDCARD to be used in a wildcard query
                return {
                  wildcard: {
                    [`${field}.raw`]: { value: `*${valueFromWildcardSpecialValue(v)}*`, case_insensitive: true },
                  },
                };
              else return { terms: { [`${field}.raw`]: [v] } };
            },
          ),
        },
      };
      break;
    case "dates":
      query = {
        range: { [field]: omitBy({ gte: filter.value.min, lte: filter.value.max, format: "yyyy" }, isUndefined) },
      };
      break;
    case "query":
      query = { simple_query_string: { query: filter.value, fields: ["ocr"] } };
  }
  // add extraQueryField if specified
  if (filterSpec && "extraQueryField" in filterSpec && filterSpec.extraQueryField) {
    query = {
      bool: {
        must: [query, filterSpec.extraQueryField],
      },
    };
  }
  // special case of nested
  if (field.includes(".")) {
    query = {
      nested: {
        path: field.split(".")[0],
        query,
      },
    };
  }
  return query;
}

function getESQueryBody(filters: FiltersState, suggestFilter?: TermsFilterState): QueryDslQueryContainer {
  const contextFilters = suggestFilter ? omit(filters, [suggestFilter.spec.field]) : filters;
  const queries = [
    ...(!isEmpty(contextFilters)
      ? toPairs(contextFilters).flatMap(([field, filter]) =>
          getESQueryFromFilter("field" in filter.spec ? filter.spec.field : field, filter),
        )
      : []),
  ];

  if (suggestFilter && suggestFilter.value) {
    queries.push(getESQueryFromFilter(suggestFilter.spec.field, suggestFilter));
  }
  const esQuery =
    queries.length > 1
      ? {
          bool: {
            must: queries,
          },
        }
      : queries[0];
  return esQuery;
}

function getESHighlight(filters: FiltersState, suggestFilter?: { field: string; value: string | undefined }) {
  // TODO: add highlight conf into filter specs
  return {
    fields: toPairs(filters)
      .map(([field, filter]) => {
        if (filter.type === "query") return { [field]: { number_of_fragments: 2, fragment_size: 50 } };
        return null;
      })
      .filter(identity),
  };
}

export type SchemaFieldDefinition = {
  id: string;
  required: boolean;
  type: string;
  name: string;
  depth?: number;
  isArray?: boolean;
  resourceTypes?: Array<string>;
};

export type SchemaModelDefinition = {
  id: string;
  name: string;
  index_name?: string;
  index_configuration?: any;
  fields: Array<SchemaFieldDefinition>;
};

/**
 * GENERIC FUNCTIONS:
 * ******************
 */
function getESIncludeRegexp(query: string): string {
  return ".*" + [...query.toLowerCase()].map((char) => `[${char}${char.toUpperCase()}]`).join("") + ".*";
}

export async function getTerms(
  context: ESSearchQueryContext,
  filter: TermsFilterType,
  value?: string,
  count?: number,
): Promise<{ term: string; count: number }[]> {
  const field = filter.field;
  //nested
  const isNested = field.includes(".");
  const nestedPath = isNested ? field.split(".")[0] : null;

  const searchQuery: SearchRequest = {
    body: {
      size: 0,
      query: getESQueryBody(
        context.filters,
        // create a temporaru filterState with a wildcardValue to trigger options suggestions the same way a wildcard choice would do
        value !== undefined ? { spec: filter, value: [wildcardSpecialValue(value)], type: "terms" } : undefined,
      ),
      aggs: {
        termsList: {
          terms: {
            field: `${field}.raw`,
            size: count || 15,
            order: filter.order === "key_asc" ? { _key: "asc" } : { _count: "desc" },
            include: value ? `.*${getESIncludeRegexp(value)}.*` : undefined,
          },
        },
      },
    },
  };
  // extraQueryField
  if (filter.extraQueryField && searchQuery.body?.aggs?.termsList) {
    searchQuery.body.aggs.termsList.aggs = {
      extra: {
        filter: filter.extraQueryField,
      },
    };
  }

  // nested case
  if (isNested && nestedPath && searchQuery.body) {
    searchQuery.body.aggs = {
      [nestedPath]: {
        nested: { path: nestedPath },
        aggs: searchQuery.body.aggs,
      },
    };
  }

  return await fetch(`${config.api_path}/elasticsearch/proxy_search/${context.index}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(searchQuery.body),
  })
    .then((res) => res.json())
    .then((data) => {
      const buckets =
        isNested && nestedPath ? data.aggregations[nestedPath].termsList.buckets : data.aggregations.termsList.buckets;
      return buckets
        .map((bucket: { key: string; doc_count: number; extra?: { doc_count: number } }) => ({
          term: bucket.key,
          count: filter.extraQueryField && bucket.extra ? bucket.extra.doc_count : bucket.doc_count,
        }))
        .filter((t: { term: string; count: number }) => t.count > 0);
    });
}

export function search<ResultType>(
  context: ESSearchQueryContext,
  cleanFn: (rawData: PlainObject) => ResultType,
  from: number,
  size: number,
  signal?: AbortSignal,
): Promise<{ data: SearchResult<ResultType>[]; total: number }> {
  return fetch(`${config.api_path}/professionDeFoi/search`, {
    signal,
    body: JSON.stringify(
      omitBy(
        {
          size,
          from,
          query: getESQueryBody(context.filters),
          sort: context.sort ? context.sort.expression : undefined,
          track_total_hits: true,
          highlight: getESHighlight(context.filters),
        },
        isUndefined,
      ),
    ),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  })
    .then((r) => r.json())
    .then((data) => ({
      data: data.hits.hits.map((d: any): ResultType => cleanFn({ ...d._source, highlight: d.highlight })),
      total: data.hits.total.value,
    }));
}

export function downSearchAsCSV(context: ESSearchQueryContext, filename: string): Promise<void> {
  return fetch(`${config.api_path}/professionDeFoi/search/csv?filename=${filename}`, {
    body: JSON.stringify({
      query: getESQueryBody(context.filters),
      sort: context.sort ? context.sort.expression : undefined,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  })
    .then((res) => res.blob())
    .then((blob) => {
      const link = document.createElement("a");
      link.setAttribute("href", window.URL.createObjectURL(blob));
      link.setAttribute("download", filename);
      link.click();
    });
}

export async function fetchDashboardData(
  context: ESSearchQueryContext,
  signal: AbortSignal,
): Promise<{ total: number; data: number }> {
  return { total: 10, data: 2 };
}
