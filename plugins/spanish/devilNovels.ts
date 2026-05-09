import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as loadCheerio } from 'cheerio';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

/**
 * Plugin para DevilNovels (devilnovels.com)
 * Sitio de traducción de novelas al español con diseño propio (no WordPress estándar).
 *
 * Estructura del sitio:
 * - Listado de novelas: /listado-de-novelas/ (página única, sin paginación)
 * - Novela: /nombre-novela/
 * - Capítulos: cargados via AJAX a wp-admin/admin-ajax.php
 *   - action: dv_load_chapters
 *   - cat_id: extraído del script inline de la página de la novela
 *   - page: número de página (100 capítulos por página)
 * - Capítulo: /nombre-novela/nombre-capitulo/id/
 * - Búsqueda: usa un endpoint propio en /wp-admin/admin-ajax.php con action=dv_search
 */

class DevilNovelsPlugin implements Plugin.PluginBase {
  id = 'devilnovels';
  name = 'DevilNovels';
  icon = 'src/es/devilnovels/icon.png';
  site = 'https://devilnovels.com';
  version = '1.0.0';
  filters = undefined;

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const url = `${this.site}/listado-de-novelas/`;
    const result = await fetchApi(url);
    const body = await result.text();
    const $ = loadCheerio(body);

    const novels: Plugin.NovelItem[] = [];

    $('.pvc-featured-page-item').each((_i, el) => {
      const titleEl = $(el).find('.pvc-page-title a').first();
      const name = titleEl.text().trim();
      const href = titleEl.attr('href') || '';
      const img = $(el).find('img').first();
      const cover = img.attr('src') || defaultCover;

      if (!name || !href) return;

      try {
        const path = new URL(href).pathname;
        novels.push({ name, path, cover });
      } catch {
        return;
      }
    });

    return novels;
  }
  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = this.site + novelPath;
    const result = await fetchApi(url);
    const body = await result.text();
    const $ = loadCheerio(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: $('h1').first().text().trim() || '',
    };

    // Portada
    novel.cover =
      $('img.novel-cover, .novel-image img, .cover img').first().attr('src') ||
      $('img').first().attr('src') ||
      defaultCover;

    // Estado
    const statusText = $(
      '*:contains("En emisión"), *:contains("Finalizada"), *:contains("Hiatus")',
    )
      .first()
      .text()
      .toLowerCase();
    if (statusText.includes('finaliz') || statusText.includes('complet')) {
      novel.status = NovelStatus.Completed;
    } else if (
      statusText.includes('emisión') ||
      statusText.includes('ongoing')
    ) {
      novel.status = NovelStatus.Ongoing;
    } else if (statusText.includes('hiatus') || statusText.includes('pausa')) {
      novel.status = NovelStatus.OnHiatus;
    }

    // Sinopsis
    novel.summary = $(
      '.novel-sinopsis, .sinopsis, .summary, [class*="sinopsis"]',
    )
      .first()
      .text()
      .trim();

    // Extraer CAT_ID y total de páginas del script inline

    const catIdMatch = body.match(/CAT_ID\s*=\s*(\d+)/);
    const totalChMatch = body.match(/TOTAL_CH\s*=\s*(\d+)/);
    const perPageMatch = body.match(/PER_PAGE\s*=\s*(\d+)/);

    if (!catIdMatch) {
      novel.chapters = [];
      return novel;
    }

    const catId = catIdMatch[1];
    const totalCh = totalChMatch ? parseInt(totalChMatch[1]) : 0;
    const perPage = perPageMatch ? parseInt(perPageMatch[1]) : 100;
    const totalPages = Math.ceil(totalCh / perPage);

    // Obtener todos los capítulos paginados via AJAX
    const chapters: Plugin.ChapterItem[] = [];

    for (let page = 1; page <= totalPages; page++) {
      const params = new URLSearchParams();
      params.append('action', 'dv_load_chapters');
      params.append('cat_id', catId);
      params.append('page', String(page));
      params.append('search', '');

      const ajaxResult = await fetchApi(
        `${this.site}/wp-admin/admin-ajax.php`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: params.toString(),
        },
      );

      const data = await ajaxResult.json();

      const chaptersData = data?.data?.chapters || data?.chapters;
      if (chaptersData && Array.isArray(chaptersData)) {
        for (const ch of chaptersData) {
          if (!ch.link || !ch.title) continue;

          let chapterPath: string;
          try {
            chapterPath = new URL(ch.link).pathname;
          } catch {
            continue;
          }

          const numMatch = ch.title.match(/(\d+(?:\.\d+)?)(?:\s|$)/);
          const chapterNumber = numMatch ? parseFloat(numMatch[1]) : undefined;

          chapters.push({
            name: ch.title,
            path: chapterPath,
            releaseTime: null,
            chapterNumber,
          });
        }
      }
    }

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.site + chapterPath;
    const result = await fetchApi(url);
    const body = await result.text();
    const $ = loadCheerio(body);

    // Eliminar elementos no deseados
    $(
      'script, style, nav, header, footer, .dv-inline-comments, .dv-comments-box, .dv-comments-list',
    ).remove();

    // Selector confirmado via inspección del DOM
    const content = $('.dv-post-wrap').first();

    if (content.length && (content.html() || '').trim().length > 100) {
      return content.html() || '';
    }

    // Fallback por si acaso
    return $('.page-content').first().html() || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // El sitio filtra en frontend, cargamos listado y filtramos localmente
    const allNovels = await this.popularNovels(1, { showLatestNovels: false });
    const term = searchTerm.toLowerCase().trim();
    return allNovels.filter(novel => novel.name.toLowerCase().includes(term));
  }

  resolveUrl = (path: string, _isNovel?: boolean) => this.site + path;
}

export default new DevilNovelsPlugin();
