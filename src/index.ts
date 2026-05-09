import type {
  Plugin,
  SearchAdapter,
  SearchContent,
  SearchFilters,
  SearchSource,
} from '@yandu/types';
import { XMLParser } from 'fast-xml-parser';

const ARXIV_API_BASE = 'http://export.arxiv.org/api/query';
const MAX_RESULTS_PER_PAGE = 50;

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  author: Array<{ name: string }> | { name: string };
  published: string;
  updated?: string;
  'arxiv:doi'?: string;
  'arxiv:primary_category'?: { '@_term': string };
  category?: Array<{ '@_term': string }> | { '@_term': string };
  link?: Array<{ '@_href': string; '@_type'?: string; '@_title'?: string }> | { '@_href': string; '@_type'?: string; '@_title'?: string };
}

interface ArxivFeed {
  feed: {
    entry?: ArxivEntry[] | ArxivEntry;
    'opensearch:totalResults'?: { '#text': string };
    'opensearch:startIndex'?: { '#text': string };
    'opensearch:itemsPerPage'?: { '#text': string };
  };
}

class ArxivSearchAdapter implements SearchAdapter {
  id: SearchSource = 'arxiv';
  private abortController?: AbortController;

  async search(
    query: string,
    filters: SearchFilters,
    cursor?: string
  ): Promise<{
    contents: SearchContent[];
    hasMore: boolean;
    nextCursor?: string;
    totalCount?: number;
  }> {
    this.abortController = new AbortController();

    try {
      const searchQuery = this.buildSearchQuery(query, filters);
      const start = cursor ? parseInt(cursor, 10) : 0;
      const maxResults = filters.maxResults ?? MAX_RESULTS_PER_PAGE;

      const url = new URL(ARXIV_API_BASE);
      url.searchParams.append('search_query', searchQuery);
      url.searchParams.append('start', String(start));
      url.searchParams.append('max_results', String(maxResults));
      url.searchParams.append('sortBy', 'relevance');
      url.searchParams.append('sortOrder', 'descending');

      const response = await fetch(url.toString(), {
        signal: this.abortController.signal,
        headers: {
          Accept: 'application/atom+xml',
        },
      });

      if (!response.ok) {
        throw new Error(
          `arXiv API error: ${response.status} ${response.statusText}`
        );
      }

      const xmlText = await response.text();

      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        parseAttributeValue: false,
      });

      const parsed: ArxivFeed = parser.parse(xmlText);

      const entries = this.normalizeEntries(parsed.feed?.entry);
      const totalResults = parseInt(
        parsed.feed?.['opensearch:totalResults']?.['#text'] || '0',
        10
      );

      const contents = entries.map((entry) => this.entryToSearchContent(entry));
      const hasMore = start + entries.length < totalResults;

      return {
        contents,
        hasMore,
        nextCursor: hasMore ? String(start + entries.length) : undefined,
        totalCount: totalResults,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Search was cancelled');
      }
      throw error;
    } finally {
      this.abortController = undefined;
    }
  }

  private buildSearchQuery(query: string, filters: SearchFilters): string {
    const escapedQuery = query.replace(/"/g, '""');

    switch (filters.scope) {
      case 'title':
        return `ti:"${escapedQuery}"`;
      case 'abstract':
        return `abs:"${escapedQuery}"`;
      case 'author':
        return `au:"${escapedQuery}"`;
      case 'all':
      default:
        return `all:"${escapedQuery}"`;
    }
  }

  private normalizeEntries(entry?: ArxivEntry[] | ArxivEntry): ArxivEntry[] {
    if (!entry) return [];
    return Array.isArray(entry) ? entry : [entry];
  }

  private entryToSearchContent(entry: ArxivEntry): SearchContent {
    const arxivId = this.extractArxivId(entry.id);
    const authors = this.normalizeAuthors(entry.author);
    const pdfUrl = this.extractPdfUrl(entry.link);
    const categories = this.extractCategories(entry.category);
    const doi = entry['arxiv:doi'];

    return {
      id: `arxiv-${arxivId}`,
      type: 'paper',
      title: this.cleanText(entry.title),
      abstract: this.cleanText(entry.summary),
      authors,
      publishedAt: new Date(entry.published),
      source: 'arxiv',
      sourceUrl: entry.id,
      externalIds: {
        arxiv: arxivId,
        doi,
      },
      pdfUrl,
      openAccess: true,
      rawData: {
        ...entry,
        categories,
      },
    };
  }

  private extractArxivId(url: string): string {
    const match = url.match(/arxiv\.org\/abs\/(\d+\.\d+)/);
    return match ? match[1] : url;
  }

  private normalizeAuthors(
    author?: Array<{ name: string }> | { name: string }
  ): string[] {
    if (!author) return [];
    if (Array.isArray(author)) {
      return author.map((a) => a.name);
    }
    return [author.name];
  }

  private extractPdfUrl(
    link?:
      | Array<{ '@_href': string; '@_type'?: string; '@_title'?: string }>
      | { '@_href': string; '@_type'?: string; '@_title'?: string }
  ): string | undefined {
    if (!link) return undefined;

    const links = Array.isArray(link) ? link : [link];

    const pdfLink = links.find((l) => l['@_type'] === 'application/pdf');
    if (pdfLink) return pdfLink['@_href'];

    const titlePdfLink = links.find((l) => l['@_title'] === 'pdf');
    if (titlePdfLink) return titlePdfLink['@_href'];

    return undefined;
  }

  private extractCategories(
    category?: Array<{ '@_term': string }> | { '@_term': string }
  ): string[] {
    if (!category) return [];
    if (Array.isArray(category)) {
      return category.map((c) => c['@_term']);
    }
    return [category['@_term']];
  }

  private cleanText(text: string): string {
    return text.replace(/\s+/g, ' ').replace(/\n+/g, ' ').trim();
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }
}

export default {
  name: '@yandu/plugin-search-arxiv',
  version: '1.0.0',
  register(system) {
    const adapter = new ArxivSearchAdapter();
    system.capabilities.register(
      { type: 'search', id: adapter.id, name: 'arXiv Search' },
      adapter
    );
  },
} satisfies Plugin;
