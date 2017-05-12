import {SortOption} from "./SortOption";
import {FieldIndexingOptions} from "./FieldIndexingOption";
import {FieldTermVectorOption} from "./FieldTermVectorOption";
import {IJsonSerializable} from '../../Json/IJsonSerializable';

export class IndexFieldOptions implements IJsonSerializable {
  protected sortOptions?: SortOption = null;
  protected indexing?: FieldIndexingOptions = null;
  protected storage?: boolean = null;
  protected termVector?: FieldTermVectorOption = null;
  protected suggestions?: boolean = null;
  protected analyzer?: string = null;

  constructor(sortOptions?: SortOption, indexing?: FieldIndexingOptions, storage?: boolean,
    suggestions?: boolean, termVector?: FieldTermVectorOption, analyzer?: string
  ) {
    this.sortOptions = sortOptions;
    this.indexing = indexing;
    this.storage = storage;
    this.suggestions = suggestions;
    this.termVector = termVector;
    this.analyzer = analyzer;
  }

  public toJson(): Object {
    const indexingJson: string = this.indexing ? (this.indexing as string) : null;
    const termVectorJson: string = this.termVector ? (this.termVector as string) : null;
    const sortOptionsJson: string = this.sortOptions ? (this.sortOptions as string) : null;
    const storageJson: string = (this.storage !== null) ? ((this.storage as boolean) ? 'Yes' : 'No') : null;

    return {
      "Analyzer": this.analyzer,
      "Indexing": indexingJson,
      "Sort": sortOptionsJson,
      "Spatial": null,
      "Storage": storageJson,
      "Suggestions": this.suggestions,
      "TermVector": termVectorJson
    };
  }
}