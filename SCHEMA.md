[
  {
    "name": "AX_search_product",
    "description": "Search products by query on the active representative commerce site. `page` reads a later result page on sites that support one; Amazon also accepts a cursor from a previous result.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "query": {
          "minLength": 1,
          "type": "string"
        },
        "cursor": {
          "minLength": 1,
          "type": "string"
        },
        "page": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "query"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_view_product",
    "description": "View Amazon product details, variations, selected options, and purchasable form controls by product id.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        }
      },
      "required": [
        "product_id"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_update_product",
    "description": "Update Amazon product variation selections and form values before purchase.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "variations": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_add_to_cart",
    "description": "Add a product on the active representative commerce site to the cart when that site exposes a safe cart action, optionally applying quantity and a stale-price precondition. Never checks out or places an order.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "quantity": {
          "minimum": 1,
          "type": "integer"
        },
        "expected_unit_price": {
          "minimum": 0,
          "type": "number"
        },
        "expected_currency": {
          "minLength": 3,
          "type": "string"
        },
        "variations": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [
        "product_id"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_view_cart",
    "description": "Navigate to the Amazon cart and return the current cart items.",
    "parameters": {
      "additionalProperties": false,
      "properties": {},
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_update_cart",
    "description": "Update the quantity of an Amazon cart item by product id. Set quantity to 0 to delete the item.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "quantity": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "product_id",
        "quantity"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_checkout",
    "description": "Navigate to the Amazon cart and proceed to checkout. When the checkout page is reached, returns its data (delivering_to, shipping_address, payment_method, order_summary, place_order_available). Returns status login_required when sign-in is needed; does not place an order.",
    "parameters": {
      "additionalProperties": false,
      "properties": {},
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_resolve_zip",
    "description": "Resolve a US ZIP code from an address string. Site-agnostic: callable on any page (e.g. before navigating to a provider site).",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "address": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "address"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_read_page",
    "description": "Read the current web page as Markdown so an LLM can understand the on-screen content. Site-agnostic and read-only (never navigates, clicks, or submits). scope is a CSS selector (default body); mode is auto, article (strips nav/ads for content pages), or structure (keeps forms/lists/buttons for interactive surfaces).",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "scope": {
          "type": "string"
        },
        "mode": {
          "enum": [
            "auto",
            "article",
            "structure"
          ],
          "type": "string"
        },
        "max_chars": {
          "type": "number"
        }
      },
      "type": "object"
    }
  },
  {
    "name": "AX_open_site",
    "description": "Open a supported site's home page from anywhere, by slug or explicit URL. Re-entrant: returns ready when the current page is already on that site, otherwise fires the navigation and returns navigating so the caller re-invokes on the destination. Never searches, fills, or submits.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "site": {
          "enum": [
            "11st",
            "aliexpress",
            "amazon",
            "bluemoonsoft",
            "coupang",
            "ebay",
            "etsy",
            "gmarket",
            "naver-shopping",
            "ssg",
            "thumbtack",
            "walmart"
          ],
          "type": "string"
        },
        "url": {
          "type": "string",
          "minLength": 1
        }
      },
      "type": "object"
    }
  },
  {
    "name": "AX_search_service",
    "description": "Search Thumbtack services and local pros by query and ZIP code or address.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "query": {
          "minLength": 1,
          "type": "string"
        },
        "zip_code": {
          "minLength": 5,
          "type": "string"
        },
        "address": {
          "minLength": 1,
          "type": "string"
        },
        "cursor": {
          "minLength": 1,
          "type": "string"
        },
        "filters": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [
        "query"
      ],
      "anyOf": [
        {
          "required": [
            "zip_code"
          ]
        },
        {
          "required": [
            "address"
          ]
        }
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_view_service",
    "description": "View a Thumbtack pro profile from a search result URL, including ratings, overview, services, photos, reviews, credentials, FAQs, and available actions.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "service_id": {
          "minLength": 1,
          "type": "string"
        },
        "url": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "url"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_answer_quote",
    "description": "Answer the active Thumbtack quote step, including contact fields. With auto=true it selects/fills ordinary project steps from user_requirements. It may click Next/Continue or optional-step Skip, refuses send/submit buttons, and returns retryable contact-popup errors.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "answers": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        },
        "value": {
          "minLength": 1,
          "type": "string"
        },
        "selection": {
          "minLength": 1,
          "type": "string"
        },
        "selections": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        },
        "text": {
          "minLength": 1,
          "type": "string"
        },
        "auto": {
          "type": "boolean"
        },
        "user_requirements": {
          "minLength": 1,
          "type": "string"
        },
        "contact": {
          "additionalProperties": true,
          "type": "object"
        },
        "email": {
          "minLength": 1,
          "type": "string"
        },
        "first_name": {
          "minLength": 1,
          "type": "string"
        },
        "last_name": {
          "minLength": 1,
          "type": "string"
        },
        "phone": {
          "minLength": 1,
          "type": "string"
        },
        "zip_code": {
          "minLength": 1,
          "type": "string"
        },
        "advance": {
          "type": "boolean"
        }
      },
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_open_quote",
    "description": "Open or inspect a Thumbtack quote flow from a pro profile URL. Optional step/contact values, including auto=true with user_requirements, may advance through Next/Continue or optional-step Skip; submit/send is never clicked; retryable contact-popup errors are returned.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "service_id": {
          "minLength": 1,
          "type": "string"
        },
        "url": {
          "minLength": 1,
          "type": "string"
        },
        "answers": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        },
        "value": {
          "minLength": 1,
          "type": "string"
        },
        "selection": {
          "minLength": 1,
          "type": "string"
        },
        "selections": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        },
        "text": {
          "minLength": 1,
          "type": "string"
        },
        "auto": {
          "type": "boolean"
        },
        "user_requirements": {
          "minLength": 1,
          "type": "string"
        },
        "contact": {
          "additionalProperties": true,
          "type": "object"
        },
        "email": {
          "minLength": 1,
          "type": "string"
        },
        "first_name": {
          "minLength": 1,
          "type": "string"
        },
        "last_name": {
          "minLength": 1,
          "type": "string"
        },
        "phone": {
          "minLength": 1,
          "type": "string"
        },
        "zip_code": {
          "minLength": 1,
          "type": "string"
        },
        "advance": {
          "type": "boolean"
        },
        "submit": {
          "type": "boolean"
        }
      },
      "required": [
        "url"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_submit_quote",
    "description": "Submit the active Thumbtack quote flow. Requires confirm=true; can fill remaining contact steps; returns quote details and retryable contact-popup errors such as disabled email accounts.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "confirm": {
          "const": true,
          "type": "boolean"
        },
        "contact": {
          "additionalProperties": true,
          "type": "object"
        },
        "email": {
          "minLength": 1,
          "type": "string"
        },
        "first_name": {
          "minLength": 1,
          "type": "string"
        },
        "last_name": {
          "minLength": 1,
          "type": "string"
        },
        "phone": {
          "minLength": 1,
          "type": "string"
        },
        "zip_code": {
          "minLength": 1,
          "type": "string"
        },
        "max_steps": {
          "minimum": 1,
          "type": "integer"
        }
      },
      "required": [
        "confirm"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_update_search",
    "description": "Change a search filter (service option) on the Thumbtack search-results screen by its visible choice text, then re-read the filters and matching pros.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "value": {
          "minLength": 1,
          "type": "string"
        },
        "option": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "value"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_echo",
    "description": "Debug echo. console.log and return the given arguments. Use to verify the tool pipeline or surface values for debugging.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "message": {
          "type": "string"
        },
        "data": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [
        "message"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_playground_durable_checkpoint",
    "description": "Playground-only diagnostic for a host-registered Lua durable operation. It opens and saves an operation-private checkpoint without browser navigation; returns durable_operation_required when no host grant exists.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "label": {
          "type": "string"
        }
      },
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_playground_durable_same_origin",
    "description": "Playground-only durable-operation test. Saves a checkpoint, then performs an explicit same-origin navigation to target_url so a registered operation can prove replay after reload.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "target_url": {
          "format": "uri",
          "type": "string"
        }
      },
      "required": [
        "target_url"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_playground_durable_handoff",
    "description": "Playground-only portable durable-operation test. After a host grants the command and allowlists target_url's origin, it checkpoints and requests one explicit cross-origin handoff.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "target_url": {
          "format": "uri",
          "type": "string"
        }
      },
      "required": [
        "target_url"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_get_memory",
    "description": "Read one exact saved memory key. Omit key to list all saved keys.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "key": {
          "minLength": 1,
          "type": "string"
        }
      },
      "type": "object"
    }
  },
  {
    "name": "AX_search_memory",
    "description": "Search saved memory by a case-insensitive regex and return matching keys with bounded Markdown.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "regex": {
          "maxLength": 200,
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "regex"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_set_memory_bulk",
    "description": "Set final memory values in one call. Non-empty Markdown saves; an empty string deletes the exact key.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "memory": {
          "additionalProperties": {
            "type": "string"
          },
          "minProperties": 1,
          "type": "object"
        }
      },
      "required": [
        "memory"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_delete_memory",
    "description": "Delete one or more exact GLOBAL memory keys. The calling flow must pass only keys the user explicitly selected. Keys are case-sensitive; never trim, translate, normalize, or invent them. Use a one-item array for one deletion.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "keys"
      ],
      "properties": {
        "keys": {
          "type": "array",
          "minItems": 1,
          "maxItems": 200,
          "uniqueItems": true,
          "description": "Exact GLOBAL logical memory keys to delete.",
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    }
  },
  {
    "name": "AX_prepare_product_identity",
    "description": "Classify a cross-store request as an exact manufacturer model or a product family that needs grounded discovery, and choose a deterministic frontier of at most three requested stores.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "product_category": {
          "type": "string",
          "minLength": 1
        },
        "requested_brand": {
          "type": "string",
          "minLength": 1
        },
        "requested_model": {
          "type": "string",
          "minLength": 1
        },
        "hard_constraints": {
          "type": "object"
        },
        "soft_preferences": {
          "type": "object"
        },
        "stores": {
          "type": "array",
          "minItems": 2,
          "maxItems": 10,
          "items": {
            "type": "object",
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  },
  {
    "name": "AX_lock_product_identity",
    "description": "Create a stable product-identity id and fingerprint from an explicit or grounded manufacturer model plus its hard constraints.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "identity_kind"
      ],
      "properties": {
        "identity_kind": {
          "type": "string",
          "enum": [
            "standardized_model",
            "spec_equivalent",
            "unique_listing"
          ]
        },
        "identity_name": {
          "type": "string"
        },
        "identity_brand": {
          "type": "string"
        },
        "identity_model": {
          "type": "string"
        },
        "product_category": {
          "type": "string"
        },
        "canonical_query": {
          "type": "string"
        },
        "hard_constraints": {
          "type": "object"
        },
        "soft_preferences": {
          "type": "object"
        },
        "source_refs": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "source_product_id": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "AX_build_product_options",
    "description": "Group live discovery listings by grounded manufacturer model, preserve source references and sample prices, and issue a versioned option snapshot without merging different models.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "results"
      ],
      "properties": {
        "results": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "query": {
          "type": "string"
        },
        "product_category": {
          "type": "string"
        },
        "requested_brand": {
          "type": "string"
        },
        "hard_constraints": {
          "type": "object"
        },
        "soft_preferences": {
          "type": "object"
        },
        "max_options": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        }
      }
    }
  },
  {
    "name": "AX_resolve_product_option",
    "description": "Validate one selection against the current discovery version and lock only a grounded, sufficiently identified product model.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "options",
        "options_version",
        "choice_options_version"
      ],
      "properties": {
        "options": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object"
          }
        },
        "options_version": {
          "type": "string",
          "minLength": 1
        },
        "choice_index": {
          "type": "integer",
          "minimum": 1
        },
        "choice_id": {
          "type": "string"
        },
        "choice_options_version": {
          "type": "string"
        },
        "hard_constraints": {
          "type": "object"
        },
        "soft_preferences": {
          "type": "object"
        }
      }
    }
  },
  {
    "name": "AX_verify_product_offers",
    "description": "Classify store candidates as exact, ambiguous, or mismatched against one locked product identity and hard-variant snapshot before ranking.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "results",
        "identity_id",
        "identity_kind"
      ],
      "properties": {
        "results": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "identity_kind": {
          "type": "string",
          "enum": [
            "standardized_model",
            "spec_equivalent",
            "unique_listing"
          ]
        },
        "identity_brand": {
          "type": "string"
        },
        "identity_model": {
          "type": "string"
        },
        "product_category": {
          "type": "string"
        },
        "hard_constraints": {
          "type": "object"
        }
      }
    }
  },
  {
    "name": "AX_search_store_product",
    "description": "Search one supported representative commerce site for broad discovery or a locked model comparison and return live candidates with product-identity metadata, normalized USD item-plus-shipping cost, FX evidence, or an explicit access/login challenge.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "site": {
          "enum": [
            "amazon",
            "walmart",
            "ebay",
            "aliexpress",
            "etsy",
            "coupang",
            "naver-shopping",
            "gmarket",
            "11st",
            "ssg"
          ],
          "type": "string"
        },
        "query": {
          "minLength": 1,
          "type": "string"
        },
        "quantity": {
          "minimum": 1,
          "type": "integer"
        },
        "purpose": {
          "type": "string",
          "enum": [
            "discovery",
            "comparison"
          ]
        },
        "requested_brand": {
          "type": "string"
        },
        "identity_brand": {
          "type": "string"
        },
        "identity_model": {
          "type": "string"
        },
        "product_category": {
          "type": "string"
        },
        "hard_constraints": {
          "type": "object"
        }
      },
      "required": [
        "site",
        "query"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_normalize_store_product_result",
    "description": "Normalize one current site adapter result with relevance filtering, observed brand/model provenance, FX evidence, and landed item-plus-shipping cost after site readiness and navigation are resolved.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "site",
        "query",
        "result"
      ],
      "properties": {
        "site": {
          "enum": [
            "amazon",
            "walmart",
            "ebay",
            "aliexpress",
            "etsy",
            "coupang",
            "naver-shopping",
            "gmarket",
            "11st",
            "ssg"
          ],
          "type": "string"
        },
        "query": {
          "type": "string",
          "minLength": 1
        },
        "quantity": {
          "type": "integer",
          "minimum": 1
        },
        "purpose": {
          "type": "string",
          "enum": [
            "discovery",
            "comparison"
          ]
        },
        "requested_brand": {
          "type": "string"
        },
        "identity_brand": {
          "type": "string"
        },
        "identity_model": {
          "type": "string"
        },
        "product_category": {
          "type": "string"
        },
        "brand_aliases": {
          "type": "string"
        },
        "hard_constraints": {
          "type": "object"
        },
        "result": {
          "type": "object"
        }
      }
    }
  },
  {
    "name": "AX_collect_store_page",
    "description": "Merge one normalized result page into a store's accumulated candidates, re-apply the per-store cap, and report whether another result page — or another wording of the same search — is worth a navigation.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "result"
      ],
      "properties": {
        "result": {
          "type": "object"
        },
        "collected": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "page": {
          "type": "integer",
          "minimum": 1
        },
        "site": {
          "type": "string"
        },
        "query": {
          "type": "string"
        },
        "query_variants": {
          "type": "string"
        },
        "tried_queries": {
          "type": "string"
        },
        "target": {
          "type": "integer",
          "minimum": 1
        },
        "max_pages": {
          "type": "integer",
          "minimum": 1
        },
        "purpose": {
          "type": "string",
          "enum": [
            "comparison",
            "discovery"
          ]
        },
        "remote_used": {
          "type": "integer",
          "minimum": 0
        },
        "remote_budget": {
          "type": "integer",
          "minimum": 0
        }
      }
    }
  },
  {
    "name": "AX_build_offer_screening",
    "description": "Number every live listing across the searched stores into one bounded, id-backed list so a relevance judgement can name rows without seeing the offer payload.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "store_results"
      ],
      "properties": {
        "store_results": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "identity_brand": {
          "type": "string"
        },
        "identity_model": {
          "type": "string"
        },
        "product_category": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "AX_apply_offer_screening",
    "description": "Keep only the listings a relevance judgement named, apply the per-store comparison cap to what survives, and report how many rows were removed; an absent verdict keeps every row.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "store_results"
      ],
      "properties": {
        "store_results": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "screening_ids": {
          "type": "string"
        },
        "keep": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "AX_rank_store_offers",
    "description": "Deterministically rank identity-verified offers by complete total cost, fold rows without a known total out of the default window, and issue a versioned comparison snapshot with a store-outcome summary.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "results": {
          "items": {
            "type": "object"
          },
          "type": "array"
        },
        "verified_offers": {
          "items": {
            "type": "object"
          },
          "type": "array"
        },
        "failures": {
          "items": {
            "type": "object"
          },
          "type": "array"
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "quantity": {
          "minimum": 1,
          "type": "integer"
        }
      },
      "type": "object"
    }
  },
  {
    "name": "AX_present_store_offers",
    "description": "Return the exact deterministic numbered comparison question for the current comparison snapshot and reject stale snapshot identifiers.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "comparison_id"
      ],
      "properties": {
        "comparison_id": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  {
    "name": "AX_refine_store_offers",
    "description": "Move the comparison window, or filter and sort the listing from the user's own sentence. A window move keeps the comparison snapshot; a change to which offers are listed reissues it. A threshold in a currency the listing does not quote is refused rather than applied.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "comparison_id"
      ],
      "properties": {
        "comparison_id": {
          "type": "string",
          "minLength": 1
        },
        "offers": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "all_offers": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "identity_id": {
          "type": "string"
        },
        "view_page": {
          "type": "integer",
          "minimum": 1
        },
        "view_sort": {
          "type": "string",
          "enum": [
            "total_asc",
            "price_asc",
            "rating_desc",
            "delivery_asc"
          ]
        },
        "page_command": {
          "type": "string",
          "enum": [
            "next",
            "prev",
            "first",
            "last"
          ]
        },
        "page_number": {
          "type": "integer",
          "minimum": 1
        },
        "refine_request": {
          "type": "string"
        },
        "failures": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    }
  },
  {
    "name": "AX_resolve_store_offer",
    "description": "Validate a numbered offer against the current product identity, comparison version, and completed approval turn before returning exact guarded cart-mutation fields.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "offers": {
          "items": {
            "type": "object"
          },
          "type": "array"
        },
        "choice_index": {
          "minimum": 1,
          "type": "integer"
        },
        "choice_stage": {
          "type": "string",
          "const": "asked"
        },
        "choice_comparison_id": {
          "type": "string",
          "minLength": 1
        },
        "comparison_id": {
          "type": "string",
          "minLength": 1
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "quantity": {
          "minimum": 1,
          "type": "integer"
        }
      },
      "required": [
        "offers",
        "choice_index",
        "choice_stage",
        "choice_comparison_id",
        "comparison_id",
        "identity_id"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_add_store_product_to_cart",
    "description": "Navigate to the selected offer, enforce locked-identity, current-comparison, explicit-approval, model, and stale-price preconditions, and add it to the cart when safely supported, without checkout.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "site": {
          "enum": [
            "amazon",
            "walmart",
            "ebay",
            "aliexpress",
            "etsy",
            "coupang",
            "naver-shopping",
            "gmarket",
            "11st",
            "ssg"
          ],
          "type": "string"
        },
        "product_id": {
          "minLength": 1,
          "type": "string"
        },
        "quantity": {
          "minimum": 1,
          "type": "integer"
        },
        "expected_unit_price": {
          "minimum": 0,
          "type": "number"
        },
        "expected_currency": {
          "minLength": 3,
          "type": "string"
        },
        "expected_identity_model": {
          "minLength": 1,
          "type": "string"
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "comparison_id": {
          "type": "string",
          "minLength": 1
        },
        "identity_approval": {
          "const": "locked_product_identity",
          "type": "string"
        },
        "comparison_approval": {
          "const": "current_comparison",
          "type": "string"
        },
        "cart_approval": {
          "const": "user_selected_compared_offer",
          "type": "string"
        }
      },
      "required": [
        "site",
        "product_id",
        "identity_id",
        "comparison_id",
        "identity_approval",
        "comparison_approval",
        "cart_approval"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_browse_service_candidates",
    "description": "Rank, filter, window, and select searched service pros deterministically from the site data. Accepts a criterion sentence, a page move, or the numbers the user picked.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "candidates"
      ],
      "properties": {
        "candidates": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "refine_request": {
          "type": "string"
        },
        "page": {
          "type": "integer",
          "minimum": 1
        },
        "page_command": {
          "type": "string",
          "enum": [
            "next",
            "prev",
            "first",
            "last"
          ]
        },
        "page_number": {
          "type": "integer",
          "minimum": 1
        },
        "choice_numbers": {
          "type": "string"
        },
        "page_size": {
          "type": "integer",
          "minimum": 1
        }
      }
    }
  }
]
